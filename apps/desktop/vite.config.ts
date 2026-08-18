/**
 * Renderer build.
 *
 * `base: "./"` matters: the packaged app loads the page over `file://` from
 * inside the asar, where an absolute `/assets/...` resolves to the filesystem
 * root and finds nothing. Relative URLs are what make the same build work from
 * a dev server and from disk.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The shipped page declares `connect-src 'none'` — the renderer has no business
 * talking to the network, and that is enforced rather than merely intended.
 * Vite's dev client needs a WebSocket for hot reload, so the *development* page
 * gets exactly that one relaxation, and only while `vite dev` is serving it. The
 * built file is never rewritten, so a packaged app cannot inherit this.
 */
function relaxCspForDevServer() {
  return {
    name: "onshell-dev-csp",
    apply: "serve" as const,
    transformIndexHtml(html: string) {
      return html.replace("connect-src 'none'", "connect-src ws: http://localhost:*");
    }
  };
}

export default defineConfig({
  root: path.join(here, "src", "renderer"),
  base: "./",
  plugins: [react(), relaxCspForDevServer()],
  build: {
    outDir: path.join(here, "dist", "renderer"),
    emptyOutDir: true,
    // Electron ships a known Chromium, so there is no older browser to
    // down-level for and no benefit in shipping legacy output.
    target: "chrome126",
    sourcemap: false
  },
  server: {
    port: 5178,
    strictPort: true
  }
});
