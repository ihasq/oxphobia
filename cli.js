#!/usr/bin/env node

import * as acorn from 'acorn';
import { minify } from 'terser';
import { gzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

// コマンドライン引数の取得
const args = process.argv.slice(2);
const pkg = args[0];

if (!pkg) {
  console.error('\x1b[31mError: パッケージ名を指定してください。\x1b[0m');
  console.log('Usage: node cli.js <package-name>');
  process.exit(1);
}

const log = {
  info: (msg) => console.log(`\x1b[90m${msg}\x1b[0m`),
  success: (msg) => console.log(`\x1b[32m${msg}\x1b[0m`),
  error: (msg) => console.error(`\x1b[31m${msg}\x1b[0m`),
  fetch: (msg) => console.log(`\x1b[36m${msg}\x1b[0m`),
  analyze: (msg) => console.log(`\x1b[35m${msg}\x1b[0m`),
  warn: (msg) => console.log(`\x1b[33m${msg}\x1b[0m`),
};

// --- AST Utilities (Robust Walker) ---

function isProcessEnvNodeEnv(node) {
  if (!node) return false;
  // process.env.NODE_ENV の検出
  if (node.type === 'MemberExpression') {
    const propName = node.property && (node.property.name || node.property.value);
    if (propName === 'NODE_ENV') {
      const obj = node.object;
      if (obj && obj.type === 'MemberExpression') {
        const objProp = obj.property && (obj.property.name || obj.property.value);
        if (objProp === 'env') {
          const root = obj.object;
          if (root && root.name === 'process') return true;
        }
      }
    }
  }
  return false;
}

function evaluateEnvCondition(node) {
  if (!node || node.type !== 'BinaryExpression') return null;

  const getString = (n) => {
    if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
    return null;
  };

  let envSide = null, strSide = null;

  if (isProcessEnvNodeEnv(node.left)) {
    envSide = node.left; strSide = getString(node.right);
  } else if (isProcessEnvNodeEnv(node.right)) {
    envSide = node.right; strSide = getString(node.left);
  }

  if (envSide && strSide !== null) {
    if (node.operator === '===' || node.operator === '==') return strSide === 'production';
    if (node.operator === '!==' || node.operator === '!=') return strSide !== 'production';
  }
  return null;
}

/**
 * 再帰的にASTを探索し、依存関係を抽出する
 */
function findDependencies(node, deps) {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const child of node) findDependencies(child, deps);
    return;
  }

  // --- 条件分岐のハンドリング (process.env.NODE_ENV) ---
  if (node.type === 'IfStatement') {
    const isProd = evaluateEnvCondition(node.test);
    if (isProd === true) {
      findDependencies(node.consequent, deps);
      return;
    } else if (isProd === false) {
      if (node.alternate) findDependencies(node.alternate, deps);
      return;
    }
  }

  if (node.type === 'ConditionalExpression') { // 三項演算子
    const isProd = evaluateEnvCondition(node.test);
    if (isProd === true) {
      findDependencies(node.consequent, deps);
      return;
    } else if (isProd === false) {
      findDependencies(node.alternate, deps);
      return;
    }
  }

  // --- 依存関係の抽出 ---
  const extractString = (n) => {
    if (!n) return null;
    if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
    return null;
  };

  // ESM Import / Export
  if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) {
    if (node.source) {
      const val = extractString(node.source);
      if (val) deps.add(val);
    }
  }
  
  // Dynamic Import
  if (node.type === 'ImportExpression') {
    const val = extractString(node.source);
    if (val) deps.add(val);
  }

  // CommonJS require()
  if (node.type === 'CallExpression') {
    const callee = node.callee;
    const isRequire = callee && callee.type === 'Identifier' && callee.name === 'require';
    
    if (isRequire && node.arguments && node.arguments.length > 0) {
      const val = extractString(node.arguments[0]);
      if (val) deps.add(val);
    }
  }

  // --- 再帰探索 (重要なプロパティを網羅) ---
  const keysToVisit = [
    'body', 'declarations', 'init', 'expression', 'callee', 'arguments', 
    'consequent', 'alternate', 'test', 'left', 'right', 'source', 'specifiers',
    'exported', 'local', 'imported', 'program', 
    'elements', // 配列内 [require('a')]
    'properties', 'value', // オブジェクト内 { a: require('a') }
    'block', 'handler', 'finalizer' // try-catch
  ];

  for (const key of keysToVisit) {
    if (node[key]) findDependencies(node[key], deps);
  }
}


// --- Package Resolution ---

const JSDELIVR_BASE = "https://cdn.jsdelivr.net/npm/";
const NODE_BUILTINS = new Set(['fs', 'path', 'os', 'crypto', 'stream', 'http', 'https', 'zlib', 'url', 'util', 'buffer', 'events', 'assert', 'child_process', 'process', 'net', 'tls', 'dgram', 'dns', 'perf_hooks', 'worker_threads']);

function parseBareSpecifier(specifier) {
  let pkgName = specifier, subpath = "";
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    pkgName = parts[0] + "/" + (parts[1] || "");
    subpath = parts.slice(2).join("/");
  } else {
    const parts = specifier.split("/");
    pkgName = parts[0];
    subpath = parts.slice(1).join("/");
  }
  return { pkgName, subpath };
}

let pkgResolveCache = new Map();

async function resolvePackageUrl(specifier) {
  if (pkgResolveCache.has(specifier)) return pkgResolveCache.get(specifier);

  const { pkgName, subpath } = parseBareSpecifier(specifier);
  const url = `${JSDELIVR_BASE}${pkgName}/package.json`;
  
  let pkgObj = {}, pkgBase = `${JSDELIVR_BASE}${pkgName}/`;
  try {
    const res = await fetch(url);
    if (res.ok) {
      pkgObj = await res.json();
      pkgBase = `${JSDELIVR_BASE}${pkgObj.name}@${pkgObj.version}/`;
    }
  } catch(e) { /* ignore */ }

  function resolveExports(exp) {
    if (typeof exp === 'string') return exp;
    if (typeof exp === 'object' && exp !== null) {
      // 優先順位: production -> node -> require -> default -> import -> browser
      const conditions = ['production', 'node', 'require', 'default', 'import', 'browser'];
      for (const cond of conditions) {
        if (cond in exp) return resolveExports(exp[cond]);
      }
    }
    return null;
  }

  let entries = [];
  if (subpath) {
    let exportKey = `./${subpath}`;
    if (pkgObj.exports) {
        let target = pkgObj.exports[exportKey] || pkgObj.exports[exportKey + '.js'];
        if (target) {
            const subEntry = resolveExports(target);
            if (subEntry) entries.push(subEntry);
        }
    }
    entries.push(subpath);
  } else {
    if (pkgObj.exports) {
      let resolved = resolveExports(pkgObj.exports['.'] || pkgObj.exports);
      if (resolved) entries.push(resolved);
    }
    if (pkgObj.main) entries.push(pkgObj.main);
    if (pkgObj.module) entries.push(pkgObj.module);
    entries.push("index.js");
  }
  
  let targetUrls = Array.from(new Set(entries.filter(Boolean))).map(entry => {
    if (entry.startsWith("./")) entry = entry.slice(2);
    return new URL(entry, pkgBase).href;
  });

  pkgResolveCache.set(specifier, targetUrls);
  return targetUrls;
}

// --- Fetch & Parse Logic ---

let parsedUrls = new Set();
let bundleParts = [];
let activeTasks = 0;
let onQueueEmpty = null;
let hasError = false;

async function fetchFile(urls) {
  const tryFetch = async (u) => { 
    try { 
      const r = await fetch(u); 
      return (r.ok) ? r : null; 
    } catch { return null; } 
  };
  
  for (const url of urls) {
    let res = await tryFetch(url);
    if (!res && !url.match(/\.(js|mjs|cjs|ts)$/)) {
        res = await tryFetch(url + '.js') || await tryFetch(url + '.mjs') || await tryFetch(url + '/index.js');
    }
    if (res) return { code: await res.text(), finalUrl: res.url }; 
  }
  throw new Error(`Fetch failed: ${urls[0]}`);
}

async function resolveUrl(url, baseUrl) {
  if (url.startsWith('http')) return [url];
  if (NODE_BUILTINS.has(url) || url.startsWith('node:')) return null;
  
  if (url.startsWith('.') || url.startsWith('/')) {
    if (!baseUrl) return [url];
    return [new URL(url, baseUrl).href];
  }
  return await resolvePackageUrl(url);
}

function enqueueFile(url, baseUrl) {
  activeTasks++;

  (async () => {
    try {
      const targetUrls = await resolveUrl(url, baseUrl);
      if (!targetUrls || targetUrls.length === 0) return;
      
      const primaryUrl = targetUrls[0];
      if (parsedUrls.has(primaryUrl)) return;
      
      let fetchResult;
      try {
        fetchResult = await fetchFile(targetUrls);
      } catch (e) {
        log.error(` ❌ Failed to fetch: ${url}`);
        return;
      }
      
      const { code, finalUrl } = fetchResult;

      if (parsedUrls.has(finalUrl)) return;
      parsedUrls.add(finalUrl);
      if (primaryUrl !== finalUrl) parsedUrls.add(primaryUrl);
      
      log.fetch(` 📥 Downloaded: ${finalUrl}`);
      bundleParts.push(code);

      // --- パース (Acornを使用) ---
      let ast;
      try {
        ast = acorn.parse(code, { 
          ecmaVersion: 2022, 
          sourceType: 'module' // まずESMとして試行
        });
      } catch (e) {
        try {
          // 失敗したらScript(CommonJS)として試行
          ast = acorn.parse(code, { 
            ecmaVersion: 2022, 
            sourceType: 'script' 
          });
        } catch (e2) {
          log.warn(`  ⚠️ Parse failed for ${finalUrl.split('/').pop()}: ${e2.message}`);
          return; // パース失敗時は依存関係探索をスキップ
        }
      }

      if (ast) {
        const deps = new Set();
        findDependencies(ast, deps);

        if (deps.size > 0) {
          log.analyze(`  🔎 Dependencies: ${Array.from(deps).join(', ')}`);
          for (const dep of deps) {
            enqueueFile(dep, finalUrl);
          }
        }
      }

    } catch(e) { 
      hasError = true;
      log.error(` 💥 Unexpected Error (${url}): ${e.message}`);
    } finally {
      activeTasks--;
      if (activeTasks === 0 && onQueueEmpty) {
        onQueueEmpty();
      }
    }
  })();
}

// --- Main Execution ---

async function run() {
  log.success(`\n📦 Analyzing Package: ${pkg}\n`);
  
  enqueueFile(pkg, null);

  await new Promise(resolve => {
    if (activeTasks === 0) resolve();
    else onQueueEmpty = resolve;
  });

  if (bundleParts.length === 0) {
    log.error("\n❌ No files were successfully downloaded.");
    process.exit(1);
  }

  log.success(`\n✅ Dependency resolution complete.`);
  log.analyze(`⏳ Minifying with Terser (removing dead code for production)...`);
  
  let minifiedCode = "";
  try {
    const combinedCode = bundleParts.join('\n');
    
    const minifyResult = await minify(combinedCode, {
      compress: { 
        global_defs: { 'process.env.NODE_ENV': 'production' }, 
        dead_code: true,
        toplevel: false,
        passes: 2
      },
      mangle: true,
      format: { comments: false },
    });
    
    minifiedCode = minifyResult.code || combinedCode;
  } catch(e) {
    log.error(`⚠️ Minification failed: ${e.message}. Using raw size.`);
    minifiedCode = bundleParts.join('\n');
  }

  const minifiedBytes = Buffer.byteLength(minifiedCode);
  const gzipBytes = gzipSync(Buffer.from(minifiedCode)).length;
  
  console.log('\n========================================');
  console.log(` 📊 \x1b[1mResult for "${pkg}"\x1b[0m`);
  console.log('========================================');
  console.log(` Files count     : \x1b[32m${bundleParts.length}\x1b[0m`);
  console.log(` Minified size   : \x1b[33m${(minifiedBytes / 1024).toFixed(2)}\x1b[0m KB (${minifiedBytes.toLocaleString()} bytes)`);
  console.log(` Gzipped size    : \x1b[32m\x1b[1m${(gzipBytes / 1024).toFixed(2)}\x1b[0m KB (${gzipBytes.toLocaleString()} bytes)`);
  console.log('========================================\n');
}

run();
