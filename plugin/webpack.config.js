const path = require("path");
const webpack = require("webpack");

module.exports = (env, argv) => {
  // Compile-time gate for the Pro Smash Engine. See ColorSmash_Masterplan_v1.md
  // §2.3-§2.4. Free build sets this to false; everything under src/core/smash/
  // and src/ui/smash/ becomes dead code via terser DCE.
  const smashEnabled = env?.smash === "true" || env?.smash === true;

  return {
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
    plugins: [
      new webpack.DefinePlugin({
        __SMASH_ENABLED__: JSON.stringify(smashEnabled),
      }),
    ],
    // v1.20.70 — silence the bundle-size warnings. The defaults (244 KiB) are
    // tuned for over-the-wire web payloads; a UXP plugin ships locally and
    // doesn't care about network-perf budgets. React-dom alone is ~131 KiB
    // and we can't reasonably split it.
    performance: { hints: false },
  };
};
