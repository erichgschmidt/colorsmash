const path = require("path");

module.exports = {
  entry: "./src/index.tsx",
  target: "web",
  // UXP blocks eval()/new Function() (CSP). Webpack's default devtool for development is
  // "eval" which produces such code — override to a non-eval source map (or none) so
  // npm run watch builds stay UXP-loadable.
  devtool: "source-map",
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
};
