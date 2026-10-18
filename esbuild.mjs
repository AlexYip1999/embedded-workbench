import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  external: ["vscode"],
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "dist/extension.js",
  sourcemap: true,
  minify: false,
});

console.log("built dist/extension.js");
