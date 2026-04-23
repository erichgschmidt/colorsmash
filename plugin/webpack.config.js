const path = require("path");

module.exports = {
  entry: "./src/index.tsx",
  target: "web",
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
      // Inline SVGs as raw strings so we can dangerouslySetInnerHTML and currentColor works.
      { test: /\.svg$/, type: "asset/source" },
    ],
  },
};
