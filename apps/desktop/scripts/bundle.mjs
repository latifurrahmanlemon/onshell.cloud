/**
 * Bundles the main process and the preload with esbuild.
 *
 * Why bundle rather than `tsc` plus workspace symlinks: electron-builder packs
 * the app by walking its production dependencies, and `@onshell/api-client` and
 * `@onshell/agent` are symlinked workspace packages whose real files sit outside
 * this directory. asar cannot compute a relative path for a file outside the app
 * root and aborts. Folding them into our own bundle removes the symlinks
 * entirely, so the packaged app is `dist/**` plus the two genuinely native
 * modules, which stay external for electron-builder to rebuild against
 * Electron's ABI.
 *
 * main    → ESM (Electron 31 supports an ESM main, and the code uses import.meta)
 * preload → CJS (a sandboxed preload is evaluated as CommonJS)
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");

const external = ["electron", "node-pty", "ssh2"];
const shared = { bundle: true, platform: "node", target: "node20", external, logLevel: "info" };

/**
 * Gives the ESM bundle a working `require`.
 *
 * With `platform: "node"` the builtins stay external, so a CommonJS dependency
 * folded into an ESM bundle keeps its `require("events")`. esbuild cannot
 * rewrite that into an import and emits a `__require` shim whose only behaviour
 * is to throw — which kills the app on launch, before any window opens. The shim
 * defers to a global `require` when one exists, so defining a real one is all it
 * takes. It has to be a banner, not an import: it must be evaluated before the
 * shim, which esbuild emits above every module.
 */
const esmRequireShim = [
  "import { createRequire as __createRequire } from 'node:module';",
  "const require = __createRequire(import.meta.url);"
].join("\n");

await build({
  ...shared,
  entryPoints: [join(app, "src", "main", "index.ts")],
  outfile: join(app, "dist", "main.js"),
  format: "esm",
  banner: { js: esmRequireShim }
});

await build({
  ...shared,
  entryPoints: [join(app, "src", "preload", "index.ts")],
  outfile: join(app, "dist", "preload.cjs"),
  format: "cjs"
});

console.log("[bundle] main.js (esm) + preload.cjs (cjs)");
