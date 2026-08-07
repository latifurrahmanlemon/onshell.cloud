/**
 * tsc only emits the .ts files; the renderer's HTML has to be placed next to the
 * compiled main by hand. Kept as a Node script rather than a `cp` so the build
 * step is identical on the Windows and Linux CI runners.
 */
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src", "renderer");
const dest = join(here, "..", "dist", "renderer");

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`[copy-renderer] ${src} → ${dest}`);
