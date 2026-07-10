# Onshell.cloud

Onshell.cloud is a browser-based SaaS platform for SSH terminals, SFTP file operations, RDP sessions, saved hosts, encrypted credentials, snippets, audit logs, subscriptions, packages, SMTP, and platform administration.

## Apps

* `apps/web` - Next.js public SaaS page, customer console, and admin panel
* `apps/api` - Fastify API with auth, hosts, credentials, sessions, billing, plans, SMTP, settings, and audit routes
* `apps/gateway` - SSH/SFTP/RDP gateway service skeleton
* `packages/shared` - shared types and RBAC/business helpers
* `packages/config` - environment config loader
* `packages/ui` - shared UI utilities

## Requirements

* Node.js 22+
* Yarn 4 through Corepack
* Docker Desktop for MySQL, Redis, and guacd

## Start From Fresh Clone

```bash
corepack enable
yarn install
copy .env.example .env
```

Update `.env` before production. The seed script creates a platform admin. It uses `ADMIN_EMAIL` and `ADMIN_PASSWORD` when provided; otherwise it falls back to the local development admin requested for this project.

## Database Migration And Seed

Start local infrastructure:

```bash
docker compose up -d mysql redis guacd
```

Generate Prisma client, run migrations, and seed packages/admin/settings:

```bash
yarn db:generate
yarn db:migrate
yarn db:seed
```

If you use a local MySQL service installed on this machine, it may listen on a different port such as `3307`. In that case set:

```env
DATABASE_URL=mysql://onshell:onshell@localhost:3307/onshell_cloud
```

The local database still needs a matching `onshell` user/database or a MySQL admin (root) password to create them.

For production deploys, use:

```bash
yarn db:deploy
yarn db:seed
```

`yarn db:seed` is idempotent: it upserts the admin user, Onshell.cloud organization, Starter/Business/Enterprise packages, default subscription, SMTP settings, brand settings, and payment provider settings.

## Run Development

```bash
yarn dev
```

URLs:

* Public SaaS page: `http://localhost:3000`
* Login page: `http://localhost:3000/login`
* Customer console: `http://localhost:3000/console`
* Admin panel: `http://localhost:3000/admin`
* API: `http://localhost:4000`
* Gateway: `http://localhost:4100`

## Docker Development

```bash
docker compose up --build
```

The Compose stack includes:

* MySQL
* Redis
* guacd
* API
* Gateway
* Web

## Production Deployment Flow

1. Provision MySQL and Redis.
2. Configure DNS for `onshell.cloud`.
3. Set production environment variables.
4. Build services:

```bash
yarn build
```

5. Apply migrations:

```bash
yarn db:deploy
```

6. Seed platform defaults once:

```bash
yarn db:seed
```

7. Start containers or your process manager.
8. Put Web, API, and Gateway behind HTTPS.
9. Configure SMTP from `/admin`.
10. Configure package prices and payment provider from `/admin`.
11. Schedule database backups:

```bash
yarn db:backup
```

## Admin Capabilities

The admin panel is designed for business operations:

* Manage SaaS packages and pricing
* Manage users and platform-admin access
* Configure SMTP for invitations, resets, invoices, and alerts
* Configure payment provider settings
* Review subscriptions and usage
* Manage brand/platform settings
* Monitor hosts, sessions, and audit activity

## API Highlights

Public:

```text
GET  /plans
POST /checkout
```

Auth and console:

```text
GET  /auth/me
POST /auth/register
POST /auth/login
GET  /hosts
POST /hosts
GET  /sessions
POST /sessions
GET  /snippets
GET  /audit
```

Admin:

```text
GET   /admin/overview
GET   /admin/users
GET   /admin/plans
POST  /admin/plans
PATCH /admin/plans/:planId
GET   /admin/subscriptions
GET   /admin/smtp
PATCH /admin/smtp
GET   /admin/settings
PATCH /admin/settings
```

Auth and 2FA:

```text
POST /auth/login
POST /auth/2fa/setup
POST /auth/2fa/verify
POST /auth/2fa/complete
POST /auth/2fa/disable
GET  /auth/2fa/status
GET  /auth/google/start
GET  /auth/google
GET  /auth/google/callback
```

## Google Login And Google Authenticator

Email/password login remains enabled. Google login is available after setting:

```env
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_REDIRECT_URI=https://api.onshell.cloud/auth/google/callback
```

For local development use:

```env
GOOGLE_REDIRECT_URI=http://localhost:4000/auth/google/callback
```

Google Authenticator 2FA flow:

1. Call `POST /auth/2fa/setup`.
2. Scan the returned `qrCodeDataUrl` with Google Authenticator or enter `manualEntryKey`.
3. Call `POST /auth/2fa/verify` with the 6-digit code.
4. Future email/password or Google logins will require `POST /auth/2fa/complete` before entering the console.

## Current Implementation Status

Implemented:

* Yarn workspace monorepo
* Public SaaS package page
* Customer remote-access console
* Admin management panel
* Fastify API route contracts
* Prisma schema, migration, and seed
* Gateway session skeleton
* Docker Compose infrastructure

Pending production work:

* Connect frontend mutation forms for creating/updating all admin resources
* Integrate real checkout provider
* Expand gateway tests with disposable SSH/RDP containers
* Add production observability and rate limiting
