#!/usr/bin/env node

import { parseSync } from 'oxc-parser';
import { minifySync } from 'oxc-minify';
import { gzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';

// --- Logger ---
const log = {
  info: (msg) => console.log(`\x1b[90m${msg}\x1b[0m`),
  success: (msg) => console.log(`\x1b[32m${msg}\x1b[0m`),
  error: (msg) => console.error(`\x1b[31m${msg}\x1b[0m`),
  fetch: (msg) => console.log(`\x1b[36m${msg}\x1b[0m`),
  analyze: (msg) => console.log(`\x1b[35m${msg}\x1b[0m`),
  warn: (msg) => console.log(`\x1b[33m${msg}\x1b[0m`),
};

// --- Command Line Arguments & Mode Detection ---
const args = process.argv.slice(2);
let targetPkg = args[0];
let isLocalMode = false;
let localProjectRoot = process.cwd();

// 引数がない場合はローカルモードとして動作
if (!targetPkg) {
  const localPkgJsonPath = path.join(localProjectRoot, 'package.json');
  
  if (fs.existsSync(localPkgJsonPath)) {
    try {
      const pkgData = JSON.parse(fs.readFileSync(localPkgJsonPath, 'utf-8'));
      targetPkg = pkgData.name || 'local-project';
      isLocalMode = true;
      
      // エントリーポイントの特定
      let entry = pkgData.main || pkgData.module || pkgData.exports?.['.'] || 'index.js';
      if (typeof entry === 'object') entry = entry.import || entry.default || 'index.js';
      
      // ローカルのエントリーファイルを絶対パスとしてセット
      targetPkg = path.resolve(localProjectRoot, entry);
      
      log.info(`📂 Local project detected: ${pkgData.name || 'unnamed'}`);
      log.info(`🚀 Entry point: ${path.relative(process.cwd(), targetPkg)}`);
    } catch (e) {
      log.error('❌ Failed to read package.json');
      process.exit(1);
    }
  } else {
    console.error('\x1b[31mError: パッケージ名を指定するか、npmプロジェクトのルートで実行してください。\x1b[0m');
    console.log('Usage: npx oxphobia <package-name>');
    console.log('       npx oxphobia (inside a project)');
    process.exit(1);
  }
}

// --- AST Utilities (Oxc Walker) ---

function isProcessEnvNodeEnv(node) {
  if (!node) return false;
  // process.env.NODE_ENV
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
    if ((n.type === 'Literal' || n.type === 'StringLiteral') && typeof n.value === 'string') return n.value;
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
 * Oxc ASTを探索し、依存関係を抽出する
 */
function findDependencies(node, deps) {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const child of node) findDependencies(child, deps);
    return;
  }

  // process.env.NODE_ENV ハンドリング
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

  if (node.type === 'ConditionalExpression') {
    const isProd = evaluateEnvCondition(node.test);
    if (isProd === true) {
      findDependencies(node.consequent, deps);
      return;
    } else if (isProd === false) {
      findDependencies(node.alternate, deps);
      return;
    }
  }

  const extractString = (n) => {
    if (!n) return null;
    // Oxc Parser uses 'StringLiteral' often, but also supports ESTree 'Literal'
    if ((n.type === 'Literal' || n.type === 'StringLiteral') && typeof n.value === 'string') return n.value;
    return null;
  };

  // ESM Import / Export
  if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) {
    if (node.source) {
      const val = extractString(node.source);
      if (val) deps.add(val);
    }
  }
  
  // Dynamic Import: import('...')
  if (node.type === 'ImportExpression') {
    const val = extractString(node.source);
    if (val) deps.add(val);
  }

  // CommonJS require()
  if (node.type === 'CallExpression') {
    const callee = node.callee;
    // Oxc AST might represent callee differently if not standard ESTree, but usually Identifier works
    const isRequire = callee && callee.type === 'Identifier' && callee.name === 'require';
    
    if (isRequire && node.arguments && node.arguments.length > 0) {
      // Oxc puts arguments in `arguments` vector
      const val = extractString(node.arguments[0]);
      if (val) deps.add(val);
    }
  }

  // 再帰探索キー (Oxc AST構造に対応)
  const keysToVisit = [
    'body', 'declarations', 'init', 'expression', 'callee', 'arguments', 
    'consequent', 'alternate', 'test', 'left', 'right', 'source', 'specifiers',
    'exported', 'local', 'imported', 'program', 'statements',
    'elements', 'properties', 'value', 'block', 'handler', 'finalizer'
  ];

  for (const key of keysToVisit) {
    if (node[key]) findDependencies(node[key], deps);
  }
}

// --- Package Resolution ---

const JSDELIVR_BASE = "https://cdn.jsdelivr.net/npm/";
const NODE_BUILTINS = new Set(['fs', 'path', 'os', 'crypto', 'stream', 'http', 'https', 'zlib', 'url', 'util', 'buffer', 'events', 'assert', 'child_process', 'process', 'net', 'tls', 'dgram', 'dns', 'perf_hooks', 'worker_threads', 'node:fs', 'node:path', 'node:process']);

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

// ローカルファイルかどうかを判定
const isLocalFile = (url) => !url.startsWith('http');

async function fetchFile(urls) {
  // ローカルファイルの場合 (1つのパスしか来ない想定)
  if (isLocalFile(urls[0])) {
    const filePath = urls[0];
    const extensions = ['', '.js', '.mjs', '.cjs', '.ts', '/index.js'];
    
    for (const ext of extensions) {
      const tryPath = filePath + ext;
      if (fs.existsSync(tryPath) && fs.statSync(tryPath).isFile()) {
        try {
            const code = fs.readFileSync(tryPath, 'utf-8');
            return { code, finalUrl: tryPath, isLocal: true };
        } catch(e) { return null; }
      }
    }
    throw new Error(`Local file not found: ${filePath}`);
  }

  // リモート (jsDelivr) の場合
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
    if (res) return { code: await res.text(), finalUrl: res.url, isLocal: false }; 
  }
  throw new Error(`Fetch failed: ${urls[0]}`);
}

async function resolveUrl(url, baseUrl) {
  if (NODE_BUILTINS.has(url) || url.startsWith('node:')) return null;

  // 絶対URL (http)
  if (url.startsWith('http')) return [url];

  // 相対パス (. or /)
  if (url.startsWith('.') || url.startsWith('/')) {
    if (!baseUrl) return [url]; // エントリーポイント等

    // Baseがローカルファイルの場合 -> ファイルシステム上で解決
    if (isLocalFile(baseUrl)) {
        const dir = path.dirname(baseUrl);
        return [path.resolve(dir, url)];
    }
    
    // BaseがURLの場合 -> URL結合
    return [new URL(url, baseUrl).href];
  }

  // Bare Specifier (e.g. "react")
  // ローカルモードでもリモートモードでも、外部パッケージは jsDelivr から引く仕様
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
      
      const { code, finalUrl, isLocal } = fetchResult;

      if (parsedUrls.has(finalUrl)) return;
      parsedUrls.add(finalUrl);
      if (primaryUrl !== finalUrl) parsedUrls.add(primaryUrl);
      
      if (isLocal) {
        log.fetch(` 📁 Read Local: ${path.relative(process.cwd(), finalUrl)}`);
      } else {
        log.fetch(` 📥 Downloaded: ${finalUrl}`);
      }
      
      bundleParts.push(code);

      // --- パース (Oxc Parserを使用) ---
      let program;
      try {
        // Oxc parseSync returns { program, errors }
        const ret = parseSync(finalUrl, code, {
            sourceType: 'module', // ESMを基本とする
            sourceFilename: finalUrl
        });
        
        if (ret.errors.length > 0) {
            // エラーがあってもASTが返る場合があるが、警告を出す
            // log.warn(`  ⚠️ Oxc Parse warnings for ${path.basename(finalUrl)}`);
        }
        program = ret.program;
      } catch (e) {
        log.warn(`  ⚠️ Parse failed for ${path.basename(finalUrl)}: ${e.message}`);
        return;
      }

      if (program) {
        const deps = new Set();
        findDependencies(program, deps);

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
  const displayTarget = isLocalMode ? path.relative(process.cwd(), targetPkg) : targetPkg;
  log.success(`\n📦 Analyzing Package: ${displayTarget}\n`);
  
  enqueueFile(targetPkg, null);

  await new Promise(resolve => {
    if (activeTasks === 0) resolve();
    else onQueueEmpty = resolve;
  });

  if (bundleParts.length === 0) {
    log.error("\n❌ No files were successfully processed.");
    process.exit(1);
  }

  log.success(`\n✅ Dependency resolution complete.`);
  log.analyze(`⏳ Minifying with Oxc Minify...`);
  
  let minifiedCode = "";
  try {
    const combinedCode = bundleParts.join('\n');
    
    // Oxc Minify Execution
    const result = minifySync("bundle.js", combinedCode, {
      mangle: true,
      compress: {
        dead_code: true, // Oxc may have different option keys, usually defaults are good
        drop_console: false
      },
      sourceMap: false
    });
    
    minifiedCode = result.code;

    // もしMinify結果が空の場合（エラー時など）、生コードを使用
    if (!minifiedCode) throw new Error("Empty output");

  } catch(e) {
    log.error(`⚠️ Minification failed: ${e.message}. Using raw size.`);
    minifiedCode = bundleParts.join('\n');
  }

  const minifiedBytes = Buffer.byteLength(minifiedCode);
  const gzipBytes = gzipSync(Buffer.from(minifiedCode)).length;
  
  console.log('\n========================================');
  console.log(` 📊 \x1b[1mResult for "${isLocalMode ? 'Local Project' : targetPkg}"\x1b[0m`);
  console.log('========================================');
  console.log(` Files count     : \x1b[32m${bundleParts.length}\x1b[0m`);
  console.log(` Minified size   : \x1b[33m${(minifiedBytes / 1024).toFixed(2)}\x1b[0m KB (${minifiedBytes.toLocaleString()} bytes)`);
  console.log(` Gzipped size    : \x1b[32m\x1b[1m${(gzipBytes / 1024).toFixed(2)}\x1b[0m KB (${gzipBytes.toLocaleString()} bytes)`);
  console.log('========================================\n');
}

run();