const path = require("path");

module.exports = (_env, argv) => ({
  entry: "./src/index.tsx",
  target: "web",
  mode: argv?.mode ?? "development",
  // UXP blocks eval()/new Function() (CSP). Default devtool for dev is "eval" which would
  // break loading. For dev: source-map (debuggable, slightly bigger). For production: no
  // source map at all (smaller bundle, no .js.map shipping with the .ccx).
  devtool: argv?.mode === "production" ? false : "source-map",
  output: {
    path: path.resolve(__dirname),
    filename: "index.js",
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js"],
  },
  externals: {
    photoshop: "commonjs2 photoshop",
    uxp: "commonjs2 uxp",
    os: "commonjs2 os",
  },
  module: {
    rules: [
      { test: /\.tsx?$/, loader: "ts-loader", exclude: /node_modules/ },
      // Inline small SVGs as base64 data URLs (UXP loads img src=data: reliably).
      { test: /\.svg$/, type: "asset/inline" },
    ],
  },
});
