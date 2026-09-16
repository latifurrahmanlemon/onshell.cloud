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
