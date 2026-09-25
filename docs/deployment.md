# Deployment

## Local Development

```bash
corepack enable
yarn install
cp .env.example .env
yarn db:generate
yarn db:migrate
yarn db:seed
yarn dev
```

## Compose Development

```bash
docker compose up --build
```

## Production Shape

Recommended production services:

* `web`: Next.js app behind TLS
* `api`: Fastify API
* `gateway`: SSH/SFTP/RDP session service
* `mysql`: managed MySQL
* `redis`: managed Redis
* `guacd`: isolated RDP bridge
* `reverse-proxy`: Caddy, Nginx, or managed ingress

## Environment Variables

Required:

* `PUBLIC_BASE_URL`
* `API_BASE_URL`
* `GATEWAY_BASE_URL`
* `DATABASE_URL`
* `REDIS_URL`
* `JWT_SECRET`
* `MASTER_ENCRYPTION_KEY`
* `CORS_ORIGINS`
* `ADMIN_EMAIL`
* `ADMIN_PASSWORD`
* `GOOGLE_CLIENT_ID`
* `GOOGLE_CLIENT_SECRET`
* `GOOGLE_REDIRECT_URI`
* `SMTP_HOST`
* `SMTP_PORT`
* `SMTP_FROM_EMAIL`
* `SMTP_FROM_NAME`
* `PAYMENT_PROVIDER`
* `PAYMENT_MODE`
* `GUACD_HOST`
* `GUACD_PORT`

## TLS

Terminate TLS before traffic reaches the app services. Enforce HTTPS and secure cookies in production.

## Backups

Back up MySQL daily and before migrations. Keep restore instructions close to the deployment runbook and test restore at least once per release cycle.

Manual backup:

```bash
yarn db:backup
```

## Deploy Checklist

Run from the project root as the deployment user. Back up MySQL before applying
migrations, and stop if any command fails; do not reload services after a failed build.

```bash
cd /home/onshell/htdocs/onshell.cloud
set -a && source .env && set +a

git pull --ff-only origin master
yarn install --immutable
yarn db:generate   # regenerate Prisma Client from the checked-out schema
yarn db:deploy     # apply pending production migrations; safe to run every deploy
yarn build         # compile against the regenerated client
```

`db:generate` and `db:deploy` do different jobs: generating updates the client code
and TypeScript types, while deploying migrations updates the database. Run both
after pulling schema changes. `yarn build` does not perform either step for you.
For example, snippet ordering requires the new `Snippet.sortOrder` column as well
as a regenerated client. Publishing a desktop installer does not migrate the server.

On a first deployment, run `yarn db:seed` after migrations to create platform
defaults, then start your process manager. For an existing PM2 deployment, after
all commands above succeed:

```bash
pm2 reload ecosystem.config.cjs --update-env
pm2 status
pm2 logs --lines 50
```

Use the same Unix user that owns the existing PM2 processes. For other process
managers, restart the web, API and gateway services using that deployment's runbook.
Configure SMTP and payment providers from `/admin`, then verify the public site,
`/console`, `/admin`, API health and gateway health checks.

See [CloudPanel deployment](deploy-cloudpanel.md#14-updating--redeploying) for the
full server setup and update procedure.

## Troubleshooting: Prisma field missing during build

Errors such as `Property 'sortOrder' does not exist` or
`'sortOrder' does not exist in type 'SnippetOrderByWithRelationInput'` mean the
installed Prisma Client was generated from an older schema. After pulling the
latest code and loading the production environment, run:

```bash
yarn db:generate
yarn db:deploy
yarn build
```

Then reload the services as above. If the field is still missing, confirm that
`apps/api/prisma/schema.prisma` contains it and that `yarn db:generate` succeeded
in this checkout. A missing-column error at runtime instead indicates that the
migration has not been applied to the database used by the API.

The desktop Vite chunk-size warning is unrelated and does not fail the build.
Do not use `yarn db:reset` or `prisma migrate reset` on production; those commands
delete data. Use `yarn db:deploy`, not the development-only `yarn db:migrate`.

## Desktop 0.4.12: automatic workspace updates

Deploy the API and web changes as well as the desktop release. The
`20260920090000_workspace_sync` migration adds `Organization.syncRevision`.
Run the update procedure above, including `yarn db:generate`, `yarn db:deploy`,
`yarn build`, and the service reload. A desktop release alone cannot apply it.

Visible web and desktop clients check the workspace revision every five seconds
and refresh changed data automatically. Focus and network recovery trigger a
check; a periodic reconciliation also catches changes made outside API routes.
The revision lives in MySQL, so multiple API workers share it without Redis.
Tasks retain their existing personal ownership and organization permissions.
Background refresh preserves unsaved task text and does not restart terminals.

After deploying, open Tasks in the web console and desktop with the same account
and workspace. Add, edit, or complete a task and verify the other visible client
updates within a few seconds. Delete a snippet from desktop and verify it
vanishes in the other client. If data stays stale, check authenticated `/sync`
responses, API logs, and `yarn db:status` for the migration above.

## Web table customization

Admin and user-console tables support draggable column edges, a Columns menu,
and Reset table. Focus an edge and use Left/Right to resize with the keyboard;
Shift adjusts in larger steps and Home resets that column. Widths and visible
columns are saved per table in this browser. Table content continues to use the
existing server permissions; hiding a column does not change access to its data.

Admin Users includes registration date filters, 2FA, last-login activity, package,
organization, and sign-in methods, with selectable page sizes and additional
account/activity columns. Native tables also offer Search displayed rows; this
search only covers rows loaded on the current page.

Deploy both API and web for the additional user counts and sign-in methods.
These table changes require no new database migration. Follow the normal server
update procedure above, then verify resizing and column selection survive a page
reload and registration-date filters update the displayed user count.

## Organization logos and mobile console

Organization owners/admins can upload, preview, replace or remove a logo in
Settings > Organization, then choose Save organization. PNG, JPEG and WebP files
up to 5 MB are resized to 256px with their aspect ratio preserved. The saved logo
appears in workspace navigation and is refreshed in other open web clients.

This release adds the `20260920120000_organization_logo` migration. Deploy API
and web together using the update procedure above: generate Prisma Client,
apply production migrations, build, then reload services. Verify logo upload,
removal and reload after deploying. Without this migration, organization reads
and updates can fail because the new column is missing.

On mobile, use the top-left menu to switch sections. Table controls are the
icons at the right; action columns stay visible at the right while data scrolls.

## Desktop 0.4.13: local workspace and offline SSH

Deploy the API from this release **before** installing the new desktop build.
It adds `/desktop/offline-bundle`, offline session reporting, and idempotent
create requests using `x-onshell-offline-id`. An older API cannot replay the local
queue; the app keeps pending changes and asks for a server update. These endpoints
need no additional migration, but apply all outstanding migrations (including the
organization logo migration above).

From the production checkout, with the production environment loaded:

```bash
git pull --ff-only
yarn install --immutable
yarn db:generate
yarn db:deploy
yarn build
```

Reload the API/web/gateway services using the service-manager commands in the
update procedure above. Then install desktop 0.4.13 and sign in online once. Wait
until the bottom sync panel shows hosts ready for offline SSH. Desktop now checks
for server changes once per minute and after mutations; the web retains its
five-second revision polling. No Redis or extra sync daemon is required.

Deployment verification:

1. Sync a saved SSH host with its attached credential, task and snippet.
2. Make the API unreachable, restart desktop, and verify the saved lists remain.
3. Connect to the reachable SSH host, open SFTP, and edit tasks/snippets offline.
4. Restore the API and use Sync now. Confirm changes appear on the web and another
   desktop within its next minute; retrying must not duplicate created items.
5. Revoke a device or disable direct access, sync that device, and verify its
   cached SSH access is removed. Remote SSH credential rotation is needed to
   invalidate material on a machine that stays disconnected.

Offline SSH still needs a network route to the SSH host. Cloud-only account and
sharing operations need the API. Signing out removes local data and pending work;
closing and reopening the app preserves them. Linux requires a real OS keyring
rather than the `basic_text` fallback. See `docs/desktop.md` for conflict and
credential-storage behavior.

## Community daily publishing

The Community section adds twenty English guides, published one per day from
26 September 2026 at 09:00 Bangladesh time through 15 October. Follow the normal
update procedure (`git pull --ff-only`, `yarn install --immutable`,
`yarn db:generate`, `yarn db:deploy`, `yarn build`, then reload services). This
feature itself needs no new migration, cron job or desktop build. Restart the web
service after deploying; publishing then uses its runtime clock automatically.

The optional server environment variable `COMMUNITY_START_AT` overrides the first
publication timestamp. Configure it in the **web service** environment before
launch if a different start date is needed; keep it fixed afterward. A late
deployment makes all already-due posts available immediately. Leave it unset to
use the dates above. Do not proxy-cache `/community`, `/community/*` or
`/sitemap.xml`, including early article 404s. See [community.md](community.md) for
the complete twenty-post calendar, content editing and verification steps.
