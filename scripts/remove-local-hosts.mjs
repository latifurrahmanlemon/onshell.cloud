/**
 * Deletes the gateway-local host rows ("Onshell server (local shell)", formerly
 * "This computer") from every organization.
 *
 * Those rows were created while LOCAL_SHELL_ENABLED defaulted to on, which gave
 * each workspace a shell on the machine running the gateway — the server, not the
 * visitor's computer. The flag now defaults to off and the API both hides and
 * refuses those hosts, so this script is only for removing the leftovers.
 *
 * `Session.hostId` cascades on delete, so removing a host also removes its
 * session history rows. Run with --dry-run first to see the counts.
 *
 *   node scripts/remove-local-hosts.mjs --dry-run
 *   node scripts/remove-local-hosts.mjs
 *
 * Needs DATABASE_URL in the environment, e.g.
 *   set -a && source .env && set +a && node scripts/remove-local-hosts.mjs
 */
import { PrismaClient } from "@prisma/client";

const dryRun = process.argv.includes("--dry-run");
const prisma = new PrismaClient();

try {
  const hosts = await prisma.host.findMany({
    where: { isLocal: true },
    select: { id: true, name: true, organizationId: true }
  });

  if (hosts.length === 0) {
    console.log("No local-shell hosts found. Nothing to do.");
    process.exit(0);
  }

  const sessionCount = await prisma.session.count({
    where: { hostId: { in: hosts.map((host) => host.id) } }
  });

  console.log(`Found ${hosts.length} local-shell host(s) across ${new Set(hosts.map((h) => h.organizationId)).size} organization(s).`);
  console.log(`Deleting them will also remove ${sessionCount} session history row(s) (Session.hostId cascades).`);

  if (dryRun) {
    for (const host of hosts) console.log(`  would delete ${host.id}  ${host.name}`);
    console.log("\nDry run — nothing was changed. Re-run without --dry-run to apply.");
    process.exit(0);
  }

  // Snippets reference a host optionally, so detach rather than cascade them away.
  await prisma.snippet.updateMany({ where: { hostId: { in: hosts.map((h) => h.id) } }, data: { hostId: null } });
  const deleted = await prisma.host.deleteMany({ where: { isLocal: true } });

  console.log(`Deleted ${deleted.count} local-shell host(s).`);
} finally {
  await prisma.$disconnect();
}
