# oxphobia 🐂

> **Calculate minified & gzipped bundle size via JSDelivr + AST Analysis + Terser.**

`oxphobia` is a CLI tool that estimates the real-world cost of adding an npm package to your project. Unlike simple size checkers, it recursively downloads dependencies, performs rudimentary tree-shaking (stripping out development-only code paths), minifies the result, and calculates the Gzipped size.

It's like [BundlePhobia](https://bundlephobia.com/) right in your terminal.

## ✨ Features

- **📦 Recursive Resolution**: Resolves dependency trees using `jsDelivr` (supports ESM `import`, CommonJS `require`, and Dynamic Imports).
- **🌲 Dead Code Elimination**: Intelligently analyzes AST to skip dependencies hidden behind `process.env.NODE_ENV !== 'production'` checks.
- **⚡️ Real Metrics**: Minifies code using `Terser` to give you the actual production footprint.
- **🛠 Zero Config**: Works instantly via `npx` or `dlx`.

## 🚀 Usage

You don't need to install it. Just run it with your package manager of choice.

### npm
```bash
npx oxphobia <package-name>
# Example
npx oxphobia react
```

### pnpm
```bash
pnpm dlx oxphobia <package-name>
```

### Deno
```bash
dx npm:oxphobia <package-name>
```

### Specific Version / Subpath
You can specify versions or subpaths just like typical imports:
```bash
npx oxphobia lodash@4.17.21
npx oxphobia three/examples/jsm/loaders/GLTFLoader
```

## 📊 Output Example

```text
📦 Analyzing Package: react

 📥 Downloaded: https://cdn.jsdelivr.net/npm/react@18.3.1/index.js
 🔎 Dependencies: ./cjs/react.production.min.js
 📥 Downloaded: https://cdn.jsdelivr.net/npm/react@18.3.1/cjs/react.production.min.js
 ✅ Dependency resolution complete.
 ⏳ Minifying with Terser (removing dead code for production)...

========================================
 📊 Result for "react"
========================================
 Files count     : 2
 Minified size   : 6.23 KB (6,382 bytes)
 Gzipped size    : 2.54 KB (2,604 bytes)
========================================
```

## ⚙️ How it works

1. **Fetch**: Downloads the entry file of the package from the JSDelivr CDN.
2. **Parse**: Analyzes the source code using an AST parser.
3. **Traverse**: 
   - Detects `import` declarations, `require()` calls, and `export` statements.
   - Evaluates `process.env.NODE_ENV` conditions to skip development-only dependencies (e.g., `if (process.env.NODE_ENV !== 'production') require('prop-types')`).
4. **Bundle**: Concatenates all discovered files into a single bundle.
5. **Compress**: Minifies the bundle using `Terser` with production settings.
6. **Measure**: Calculates the final Gzip size.

## 📝 License

MIT
