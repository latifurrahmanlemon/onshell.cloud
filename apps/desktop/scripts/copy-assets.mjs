/**
 * Copies the renderer's static assets next to the bundled main process.
 *
 * The tray icons are loaded at runtime by path, and electron-builder packs only
 * `dist/**` — so an icon left in `build/` resolves to nothing inside the asar
 * and the packaged app runs with an empty tray, which is the one piece of UI
 * that must never be missing.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");

await mkdir(join(app, "dist"), { recursive: true });
for (const name of ["tray.png", "tray@2x.png"]) {
  await copyFile(join(app, "build", name), join(app, "dist", name));
}

console.log("[assets] tray icons -> dist/");
