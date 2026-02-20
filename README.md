# 📦 Oxphobia

**Oxphobia** is an ultra-fast JavaScript bundle size calculator powered by [Oxc (The Oxide JavaScript Tools)](https://github.com/oxc-project/oxc).

By leveraging the Rust-based `oxc-parser` and `oxc-minify`, it performs high-speed dependency analysis and minification to instantly measure the "Minified + Gzipped" size of npm packages or local projects.

## ✨ Features

*   🚀 **Blazing Fast**: Powered by the Rust-based Oxc toolchain for incredibly quick parsing and compression.
*   ☁️ **npm Package Support**: Recursively fetches and calculates the size of specified packages via [jsDelivr](https://www.jsdelivr.com/) .
*   📂 **Local Project Support**: Run it at your project root to automatically detect entry points and estimate the total size including dependencies.
*   🌳 **Simple Tree-Shaking**: Analyzes conditional branches based on `process.env.NODE_ENV` to exclude unnecessary code from the bundle.

## 📦 Installation

You can run it directly via `npx` or install it globally.

```bash
# Run directly
npx oxphobia [package-name]
pnpm dlx oxphobia [package-name]
yarn dlx oxphobia [package-name]
# or
dx npm:oxphobia [package-name]
# or
bunx oxphobia [package-name]
```

Or install globally:

```bash
npm install -g oxphobia
```

## 🚀 Usage

### 1. Measure npm package size

Specify a package name to fetch sources from the CDN (jsDelivr) and calculate its size.

```bash
npx oxphobia react
npx oxphobia lodash-es
npx oxphobia three
```

### 2. Measure local project size

Run without arguments to read the `package.json` in the current directory. It will identify the entry point from the `main`, `module`, or `exports` fields for analysis.

```bash
cd my-awesome-project
npx oxphobia
```

### Example Output

```text
📦 Analyzing Package: react

 📥 Downloaded: https://cdn.jsdelivr.net/npm/react@18.2.0/index.js
 🔎 Dependencies: ./cjs/react.production.min.js
 📥 Downloaded: https://cdn.jsdelivr.net/npm/react@18.2.0/cjs/react.production.min.js
 ...

✅ Dependency resolution complete.
⏳ Minifying with Oxc Minify...

========================================
 📊 Result for "react"
========================================
 Files count     : 2
 Minified size   : 6.42 KB (6,572 bytes)
 Gzipped size    : 2.75 KB (2,814 bytes)
========================================
```

## 🛠️ How It Works

1.  **Parsing**: Uses `oxc-parser` to build an AST (Abstract Syntax Tree) and extracts dependencies from `import`, `require`, and `export` statements.
2.  **Resolution**: 
    *   Local files are read from the file system.
    *   External packages are resolved and downloaded via the jsDelivr API.
3.  **Bundling**: Combines dependencies in-memory.
4.  **Minification**: Compresses the code (Mangle & Compress) using `oxc-minify`.
5.  **Measuring**: Compresses the minified code using Node.js `zlib` (Gzip) and calculates the final byte count.

## ⚠️ Limitations

*   Non-JS assets such as CSS and images are ignored.
*   Advanced bundler configurations (e.g., Webpack/Rollup/Vite plugins) are not supported. It only tracks pure JS/ESM dependencies.

## 💻 Requirements

*   Node.js >= 18.12.0

## 🤝 Contributing

Pull requests are welcome!

## 📄 License

MIT