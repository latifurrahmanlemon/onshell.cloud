/**
 * Bundles the desktop app's main and preload with esbuild.
 *
 * Why bundle instead of `tsc` + a workspace dependency: electron-builder packs
 * the app by following its production dependencies, and `@onshell/agent` is a
 * symlinked workspace package whose real files live outside this directory.
 * asar's unpack filter cannot compute a relative path for a file that sits
 * outside the app root and aborts the build. Folding the agent core into our own
 * bundle removes the symlink entirely: the packaged app then contains only
 * `dist/**` plus node-pty, the one genuinely-native dependency, which stays
 * external so electron-builder rebuilds it against Electron's ABI.
 *
 * main  → ESM  (Electron 31 supports an ESM main; the code uses import.meta.url)
 * preload → CJS (a sandboxed preload is evaluated as CommonJS)
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");

// node-pty is native and must load from the unpacked node_modules at runtime;
// electron is provided by the runtime. Everything else is inlined.
const external = ["electron", "node-pty"];
const shared = { bundle: true, platform: "node", target: "node20", external, logLevel: "info" };

/**
 * Gives the ESM bundle a working `require`.
 *
 * With `platform: "node"` the builtins stay external, so a CommonJS dependency
 * folded into an ESM bundle — `ws`, reached through the agent core — keeps its
 * `require("events")`. esbuild cannot rewrite that into an import, so it emits a
 * `__require` shim whose only behaviour is to throw:
 *
 *     Error: Dynamic require of "events" is not supported
 *
 * which killed the packaged app on its first launch, before any window opened.
 * The shim checks for a global `require` and defers to it when one exists, so
 * defining a real one here is all it takes. This must be a banner rather than an
 * import in main.ts: it has to be evaluated before the shim, which esbuild emits
 * above every module in the bundle.
 */
const esmRequireShim = [
  "import { createRequire as __createRequire } from 'node:module';",
  "const require = __createRequire(import.meta.url);"
].join("\n");

await build({
  ...shared,
  entryPoints: [join(app, "src", "main.ts")],
  outfile: join(app, "dist", "main.js"),
  format: "esm",
  banner: { js: esmRequireShim }
});

await build({
  ...shared,
  entryPoints: [join(app, "src", "preload.ts")],
  outfile: join(app, "dist", "preload.cjs"),
  format: "cjs"
});

console.log("[bundle] main.js (esm) + preload.cjs (cjs)");
