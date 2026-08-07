/**
 * tsc only emits the .ts files; the renderer's HTML has to be placed next to the
 * compiled main by hand. Kept as a Node script rather than a `cp` so the build
 * step is identical on the Windows and Linux CI runners.
 *
 * The tray icons are copied for a sharper reason. electron-builder packs only
 * `dist/**` (see electron-builder.yml), and `build/` is its buildResources
 * directory, which is deliberately kept out of the app. The tray icon used to be
 * loaded from `build/` at runtime, so in every packaged build the path did not
 * exist, nativeImage returned an empty image, and the app sat in the tray with
 * no icon at all — visible only as a gap. Anything main.ts reads at runtime has
 * to live in dist.
 */
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");

const src = join(app, "src", "renderer");
const dest = join(app, "dist", "renderer");

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`[copy-renderer] ${src} → ${dest}`);

for (const icon of ["tray.png", "tray@2x.png"]) {
  await cp(join(app, "build", icon), join(app, "dist", icon));
}
console.log("[copy-renderer] tray icons → dist");
