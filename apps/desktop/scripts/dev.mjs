/**
 * Development runner: Vite for the renderer, esbuild for main and preload, then
 * Electron pointed at the dev server.
 *
 * Electron is started only once Vite is actually listening. Launching them
 * together races, and the loser is the window, which opens on a connection
 * error and stays there.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");

const server = await createServer({ configFile: join(app, "vite.config.ts") });
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (!url) throw new Error("Vite did not report a local URL");
server.printUrls();

// Main and preload are still bundled, not run from source: Electron's main
// process has no TypeScript loader, and the packaged app runs this exact
// pipeline, so developing against a different one hides packaging bugs.
await new Promise((resolve, reject) => {
  const bundle = spawn(process.execPath, [join(here, "bundle.mjs")], { stdio: "inherit" });
  bundle.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`bundle failed (${code})`))));
}).then(
  () =>
    new Promise((resolve, reject) => {
      const assets = spawn(process.execPath, [join(here, "copy-assets.mjs")], { stdio: "inherit" });
      assets.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`assets failed (${code})`))));
    })
});

const electronBin = (await import("electron")).default;
const child = spawn(electronBin, [app], {
  stdio: "inherit",
  env: { ...process.env, ONSHELL_DEV_SERVER: url }
});

child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
