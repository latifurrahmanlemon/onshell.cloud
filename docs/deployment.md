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
* `postgres`: managed PostgreSQL
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

Back up PostgreSQL daily and before migrations. Keep restore instructions close to the deployment runbook and test restore at least once per release cycle.

Manual backup:

```bash
yarn db:backup
```

## Deploy Checklist

1. Run `yarn build`.
2. Run `yarn db:deploy`.
3. Run `yarn db:seed` on first deploy or when package defaults change.
4. Configure SMTP and payment providers from `/admin`.
5. Verify `https://onshell.cloud`, `/console`, `/admin`, `/health`, and gateway health checks.
