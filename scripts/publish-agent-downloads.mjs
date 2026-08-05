/**
 * Turns the per-platform agent builds into files the website can serve.
 *
 * `build-agent.mjs` produces a folder per platform. That folder is not something
 * to hand a person: it has no version in its name, it is not compressed, and
 * nothing about it says which of the six it is. This script takes all of them
 * and writes the shape a download page needs:
 *
 *   apps/web/public/downloads/agent/
 *     latest.json                                  what /download reads
 *     v0.1.0/
 *       onshell-agent-0.1.0-win32-x64.zip
 *       onshell-agent-0.1.0-darwin-arm64.tar.gz
 *       …
 *       SHA256SUMS.txt
 *       manifest.json
 *
 * Windows gets `.zip` because that is what Explorer opens with a double click.
 * macOS and Linux get `.tar.gz` because it survives a round trip through a
 * shell without anyone thinking about file modes.
 *
 * Checksums are not decoration here. This is a program that opens a shell on
 * the machine it runs on, so "did I get the file the vendor built" has to be a
 * question the user can actually answer.
 *
 * Usage:
 *   node scripts/publish-agent-downloads.mjs --from dist/agent
 *   node scripts/publish-agent-downloads.mjs --from staging --version 0.2.0 --keep 3
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = join(repo, "apps", "web", "public", "downloads", "agent");

/**
 * How each build identifies itself to a human choosing a download.
 *
 * The order is the order the page renders, so Windows x64 leads: it is the
 * common case, and a download page that makes the common case scan first is
 * doing most of its job.
 */
const CATALOG = [
  { target: "win32-x64", os: "windows", osLabel: "Windows", archLabel: "Intel / AMD (64-bit)", format: "zip" },
  { target: "win32-arm64", os: "windows", osLabel: "Windows", archLabel: "ARM64", format: "zip" },
  { target: "darwin-arm64", os: "macos", osLabel: "macOS", archLabel: "Apple silicon (M1–M4)", format: "tar.gz" },
  { target: "darwin-x64", os: "macos", osLabel: "macOS", archLabel: "Intel", format: "tar.gz" },
  { target: "linux-x64", os: "linux", osLabel: "Linux", archLabel: "x86_64", format: "tar.gz" },
  { target: "linux-arm64", os: "linux", osLabel: "Linux", archLabel: "ARM64", format: "tar.gz" }
];

function flag(name, fallback = undefined) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

/**
 * Newest first. Only the numeric parts are compared, so `0.10.0` sorts above
 * `0.9.0` — which a plain string sort gets backwards, and which is exactly the
 * comparison that decides what pruning deletes.
 */
function byVersionDesc(a, b) {
  const pa = a.replace(/^v/, "").split(/[.-]/);
  const pb = b.replace(/^v/, "").split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const cmp = String(pb[i] ?? "").localeCompare(String(pa[i] ?? ""));
      if (cmp !== 0) return cmp;
      continue;
    }
    if (na !== nb) return nb - na;
  }
  return 0;
}

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

/**
 * Archive `folder` (a directory name inside `parent`) into `outFile`.
 *
 * The folder is archived by name from its parent rather than by its contents,
 * so extracting produces one tidy directory instead of spraying three files
 * into whatever the user's cwd happened to be.
 */
function archive(parent, folder, outFile, format) {
  if (format === "zip") {
    if (process.platform === "win32") {
      // No `zip` on Windows. Compress-Archive is in the box and does not need
      // a wildcard, so paths with spaces survive.
      execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `Compress-Archive -Path '${join(parent, folder)}' -DestinationPath '${outFile}' -Force`],
        { stdio: "inherit" }
      );
      return;
    }
    try {
      execFileSync("zip", ["-r", "-q", outFile, folder], { cwd: parent, stdio: "inherit" });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // A runner image without `zip` should cost a slower archive, not the
      // Windows download. Python's zipfile module is on every CI Linux image.
      execFileSync("python3", ["-m", "zipfile", "-c", outFile, folder], { cwd: parent, stdio: "inherit" });
    }
    return;
  }
  // bsdtar ships with Windows 10+ as well, so this branch needs no fallback.
  execFileSync("tar", ["-czf", outFile, "-C", parent, folder], { stdio: "inherit" });
}

/**
 * Finds a built target inside `from`, accepting either the layout
 * `build-agent.mjs` writes (`dist/agent/<target>/`) or the one
 * `download-artifact` writes (`staging/onshell-agent-<target>/`).
 */
function locate(entries, target) {
  return entries.find((name) => name === target || name === `onshell-agent-${target}`);
}

async function main() {
  // `resolve`, not `join`: CI passes a relative path but a person debugging
  // locally will paste an absolute one, and join would silently mangle it.
  const from = resolve(repo, flag("from", join("dist", "agent")));
  const keep = Number(flag("keep", "3"));
  const commit = flag("commit", "");

  if (!existsSync(from)) throw new Error(`nothing to publish: ${from} does not exist`);

  const version =
    flag("version") ?? JSON.parse(await readFile(join(repo, "apps", "agent", "package.json"), "utf8")).version;

  const entries = (await readdir(from, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  const outDir = join(publicRoot, `v${version}`);
  // Staged outside the repo: the publish job runs on a checkout that never had
  // `yarn install`, and a scratch directory inside the working tree is one
  // mistyped `git add` away from being committed.
  const work = join(tmpdir(), "onshell-agent-publish");

  await rm(outDir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await mkdir(work, { recursive: true });

  const builds = [];
  const missing = [];

  for (const entry of CATALOG) {
    const found = locate(entries, entry.target);
    if (!found) {
      missing.push(entry.target);
      continue;
    }

    // Rename on the way in: the name inside the archive is the name the user
    // sees after extracting, and `onshell-agent-win32-x64` tells them nothing
    // about which version they are about to run.
    const stem = `onshell-agent-${version}-${entry.target}`;
    await cp(join(from, found), join(work, stem), { recursive: true });

    const file = `${stem}.${entry.format}`;
    const outFile = join(outDir, file);
    archive(work, stem, outFile, entry.format);

    builds.push({
      target: entry.target,
      os: entry.os,
      osLabel: entry.osLabel,
      archLabel: entry.archLabel,
      format: entry.format,
      file,
      path: `/downloads/agent/v${version}/${file}`,
      bytes: (await stat(outFile)).size,
      sha256: await sha256(outFile)
    });
  }

  await rm(work, { recursive: true, force: true });

  if (builds.length === 0) {
    throw new Error(`no known targets found in ${from} (saw: ${entries.join(", ") || "nothing"})`);
  }

  const manifest = { version, releasedAt: new Date().toISOString(), commit, builds };

  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(outDir, "SHA256SUMS.txt"),
    `${builds.map((build) => `${build.sha256}  ${build.file}`).join("\n")}\n`
  );

  // Prune before writing latest.json, so the version list it carries can never
  // advertise a folder this run just deleted.
  const versions = (await readdir(publicRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^v\d/.test(e.name))
    .map((e) => e.name)
    .sort(byVersionDesc);

  const dropped = Number.isFinite(keep) && keep > 0 ? versions.slice(keep) : [];
  for (const old of dropped) await rm(join(publicRoot, old), { recursive: true, force: true });

  const kept = versions.filter((v) => !dropped.includes(v));

  await writeFile(
    join(publicRoot, "latest.json"),
    `${JSON.stringify({ ...manifest, versions: kept.map((v) => v.replace(/^v/, "")) }, null, 2)}\n`
  );

  const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  console.log(`Published agent ${version} -> apps/web/public/downloads/agent/v${version}`);
  for (const build of builds) console.log(`  ${build.target.padEnd(14)} ${mb(build.bytes).padStart(8)}  ${build.file}`);
  if (missing.length > 0) {
    // Loud, but not fatal: a matrix leg can fail on its own without taking the
    // other five platforms' downloads offline. The page only ever lists what
    // this manifest contains, so a missing target is absent rather than broken.
    console.warn(`  ! not built, so not published: ${missing.join(", ")}`);
  }
  if (dropped.length > 0) console.log(`  pruned older versions: ${dropped.join(", ")}`);
}

await main();
