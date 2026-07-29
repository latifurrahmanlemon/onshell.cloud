/**
 * Restores the exec bit on node-pty's `spawn-helper`.
 *
 * node-pty ships prebuilt binaries per platform, and on macOS/Linux it shells out
 * to `spawn-helper` to allocate the pty. Yarn's tarball extraction does not
 * preserve file modes, so the helper lands as 0644 and every pty spawn fails with
 * a bare "posix_spawnp failed." — which the gateway then reports as "no pty
 * available" and falls back to a pipe-based shell.
 *
 * Idempotent and silent when node-pty is absent: it is an optional dependency, so
 * a deployment without it is a supported state, not an error.
 */
import { chmod, stat } from "node:fs/promises";
import { glob } from "node:fs/promises";

const pattern = "node_modules/node-pty/prebuilds/*/spawn-helper";

let fixed = 0;
try {
  for await (const path of glob(pattern)) {
    const info = await stat(path);
    // 0o111 = executable by user, group, other.
    if ((info.mode & 0o111) === 0o111) continue;
    await chmod(path, 0o755);
    fixed += 1;
  }
} catch {
  // No node-pty, or a Node build without fs.glob — nothing to repair.
}

if (fixed > 0) console.log(`node-pty: made ${fixed} spawn-helper binar${fixed === 1 ? "y" : "ies"} executable`);
