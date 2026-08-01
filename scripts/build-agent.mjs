/**
 * Packages the Onshell Agent for distribution.
 *
 * Produces `dist/agent/<platform>-<arch>/`, containing everything a customer's
 * machine needs and nothing it does not:
 *
 *   onshell-agent.cjs        the whole agent, bundled
 *   node_modules/node-pty/   the one dependency that cannot be bundled
 *   README.txt               how to run it
 *
 * node-pty stays external because it is a native module: its `.node` binary is
 * compiled per platform and per architecture, so it has to be shipped as a file
 * rather than inlined into a JavaScript bundle. That single fact is what drives
 * the whole per-platform build matrix.
 *
 * Usage:
 *   node scripts/build-agent.mjs                 build for this machine
 *   node scripts/build-agent.mjs --target win32-x64
 */
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = join(repo, "apps", "agent");

/**
 * Platforms worth building for, and the node-pty prebuild each one needs.
 *
 * `linux-arm64` is here because a surprising share of self-hosted Linux is now
 * Ampere or Graviton, and shipping only x64 would quietly exclude it.
 */
const TARGETS = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];

function parseTarget() {
  const flag = process.argv.indexOf("--target");
  const requested = flag === -1 ? `${platform()}-${arch()}` : process.argv[flag + 1];
  if (!TARGETS.includes(requested)) {
    throw new Error(`unknown target "${requested}". Known targets: ${TARGETS.join(", ")}`);
  }
  return requested;
}

const README = (target) => `Onshell Agent (${target})

This program lets a browser on onshell.cloud open a terminal on THIS computer.
It runs as you, not as an administrator, and only while it is running.

  Pair it:   node onshell-agent.cjs pair <code>
  Start it:  node onshell-agent.cjs run
  Stop it:   Ctrl+C

  See what it has done:      node onshell-agent.cjs log
  Change who may connect:    node onshell-agent.cjs approval <trusted|ask|always>
  Run it at login:           node onshell-agent.cjs service

By default, only the account that paired this computer can connect without
someone here agreeing to it first.
`;

async function main() {
  const target = parseTarget();
  const [targetPlatform, targetArch] = target.split("-");
  const outDir = join(repo, "dist", "agent", target);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const { version } = JSON.parse(await readFile(join(agentDir, "package.json"), "utf8"));

  // CommonJS, not ESM: Node's single-executable support takes a CJS entry
  // point, and this bundle is the input to that step.
  await build({
    entryPoints: [join(agentDir, "src", "main.ts")],
    outfile: join(outDir, "onshell-agent.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["node-pty"],
    minify: false,
    sourcemap: false,
    banner: {
      js: `/* Onshell Agent ${version} (${target}) — https://onshell.cloud */`
    }
  });

  const prebuild = join(repo, "node_modules", "node-pty", "prebuilds", target);
  const vendored = join(outDir, "node_modules", "node-pty");
  await mkdir(vendored, { recursive: true });

  for (const entry of ["lib", "package.json", "LICENSE"]) {
    const source = join(repo, "node_modules", "node-pty", entry);
    if (existsSync(source)) await cp(source, join(vendored, entry), { recursive: true });
  }

  if (existsSync(prebuild)) {
    await cp(prebuild, join(vendored, "prebuilds", target), {
      recursive: true,
      // `.pdb` files are Windows debug symbols — around 20 MB of them, useful
      // only for debugging node-pty itself, and pure weight in something a
      // customer downloads.
      filter: (source) => !source.endsWith(".pdb")
    });
  } else {
    // Not fatal: the agent falls back to piping a shell over stdio when node-pty
    // will not load, so a build without the prebuild still produces something
    // that works — just without job control or resize. Saying so beats shipping
    // it quietly.
    console.warn(`  ! no node-pty prebuild for ${target} in this checkout.`);
    console.warn("    Build on that platform, or fetch the prebuild, before shipping.");
  }

  await writeFile(join(outDir, "README.txt"), README(target));

  console.log(`Built ${target} -> ${outDir}`);
  console.log(`  platform: ${targetPlatform}  arch: ${targetArch}  version: ${version}`);
  console.log("");
  console.log("  Still required before this is fit to hand to anyone:");
  console.log("   - Windows: Authenticode signing, or SmartScreen will block it");
  console.log("   - macOS:   codesign + notarization, or Gatekeeper will block it");
  console.log("  An unsigned remote-access binary is indistinguishable from malware,");
  console.log("  to scanners and to users. See docs/agent.md.");
}

await main();
