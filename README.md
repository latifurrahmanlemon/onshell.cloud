# Onshell.cloud

**SSH, SFTP, and RDP for teams — from a browser tab or a desktop app.** Saved hosts, an
encrypted credential vault, snippets, per-host access grants, a full audit log, and an
in-product assistant. Run ours or run your own.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

Production domain: **https://onshell.cloud** — one host, with the API under `/api` and
the gateway under `/gateway` (see [docs/deploy-cloudpanel.md](docs/deploy-cloudpanel.md)).

## Why this repository is public

You are being asked to hand this software the credentials to your servers. That is not
a thing anyone should do on the strength of a marketing page.

So the whole platform is here — the credential vault, the session broker, the gateway,
the agent, the desktop app — under the **GNU AGPL-3.0**. Not an SDK, not a client
library, not an "open core" with the interesting parts held back. If you want to know
what happens to your private key between the moment you paste it and the moment a shell
opens, the answer is in [apps/api/src/lib/encryption.ts](apps/api/src/lib/encryption.ts)
and [apps/api/src/routes/modules/sessions.ts](apps/api/src/routes/modules/sessions.ts),
and you can go and read it right now.

The AGPL is the part that keeps that true over time: anyone who runs a modified Onshell
as a network service has to offer their users that version's source. A hosted fork
cannot quietly diverge from what is written here.

**Start with [docs/architecture.md](docs/architecture.md)** — it names, per path, which
component holds a plaintext credential and for how long, including the cases where the
answer is uncomfortable.

## Apps

* `apps/web` — Next.js public site, customer console, and admin panel
* `apps/api` — Fastify API: auth, RBAC, hosts, the credential vault, sessions, billing, plans, SMTP, settings, audit
* `apps/gateway` — SSH/SFTP/RDP sessions and agent-tunnel termination
* `apps/desktop` — the native client: this machine's own terminal, **direct** SSH that never touches our servers, relay fallback, and "share this computer" (see [docs/desktop.md](docs/desktop.md))
* `apps/agent` — headless CLI for servers and unattended machines that want to be reachable from a browser (see [docs/agent.md](docs/agent.md))
* `packages/agent-protocol` — the wire protocol between an agent and the gateway
* `packages/api-client` — the HTTP client shared by the web console and the desktop app
* `packages/shared` — shared types and RBAC/business helpers
* `packages/config` — environment config loader and production secret guards
* `packages/ui` — shared UI utilities

## How it works

Three ways to reach a shell, and you pick:

| Path | Route | Who is on the wire |
| --- | --- | --- |
| **Browser** | tab → API → gateway → your host | the gateway holds the credential for the session |
| **Desktop, direct** | app → your host, port 22 | nobody. Our servers authorise and audit; they are not in the data path |
| **Desktop, local** | app → this machine's own shell | nothing leaves the machine, including the network |

Plus the agent, for machines with no SSH server at all: it dials *out* to the gateway
so there is no inbound port to open, and its owner controls consent, policy, and
revocation from a tray icon they can see.

The trade-offs are spelled out rather than glossed:

* A browser cannot speak SSH, so browser sessions **must** relay through a server that
  holds the credential. Every product in this category works this way; we say so.
* Saved credentials are sealed with AES-256-GCM before hitting the database, and no
  route ever returns one to a client — but the operator holding `MASTER_ENCRYPTION_KEY`
  and the database can decrypt them. Self-host and the operator is you.
* Access control lives entirely in the API. The gateway has no notion of users and is
  meant to sit on a private network behind `GATEWAY_SHARED_SECRET`.

[docs/architecture.md](docs/architecture.md) has the full map, [SECURITY.md](SECURITY.md)
has the trust boundaries and how to report a hole in one.

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

Update `.env` before production.

The seed script creates a platform admin from `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
`ADMIN_PASSWORD` is **required** when seeding with `NODE_ENV=production` — the seed
refuses to create a known-password account. Outside production it generates a random
password and prints it once, so nothing credential-shaped is ever committed.

The API also refuses to boot in production while `JWT_SECRET` or
`MASTER_ENCRYPTION_KEY` still hold their `.env.example` placeholders. Generate real
values with `openssl rand -base64 48`.

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
yarn db:deploy   # applies pending migrations only — never drops data
yarn db:seed
```

### Checking And Resetting Migration State

```bash
yarn db:status   # which migrations are applied vs pending
yarn db:deploy   # apply pending migrations (safe, non-destructive)
```

`yarn db:reset` **drops the database**, replays every migration from scratch, and
re-runs the seed. It is for a genuinely fresh start only. Back up first:

```bash
set -a && source .env && set +a
yarn db:backup                      # writes backups/onshell-cloud-<timestamp>.sql
ADMIN_PASSWORD='<strong-password>' yarn db:reset --force
```

`ADMIN_PASSWORD` is required because `migrate reset` runs the seed automatically, and
the seed refuses to create a known-password admin under `NODE_ENV=production`.

If `db:deploy` fails with **P3005 (`database schema is not empty`)** — the tables exist
but Prisma has no migration history for them — baseline the existing migrations instead
of resetting:

```bash
cd apps/api
npx prisma migrate resolve --applied 20260708094000_init_saas_platform
# ...repeat for each migration already reflected in the database, then:
npx prisma migrate deploy
```

Restore a backup with:

```bash
mysql -u onshell -p onshell_cloud < backups/onshell-cloud-<timestamp>.sql
```

`yarn db:seed` is idempotent: it upserts the admin user, the Onshell.cloud
organization, the Free/Team/Business packages, the platform subscription, and the
SMTP, brand, payment-provider, Turnstile, and AI-assistant settings rows. Re-running
it never rotates a live admin password or clobbers keys an operator rotated in
`/admin` — env values are bootstrap-only, applied on first run.

## Run Development

```bash
yarn dev
```

URLs:

* Public SaaS page: `http://localhost:3000`
* Browser SSH guide (SEO pillar): `http://localhost:3000/browser-ssh-client`
* Security page: `http://localhost:3000/security`
* Contact us: `http://localhost:3000/contact`
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
2. Configure DNS for `onshell.cloud`:

```text
A/AAAA  onshell.cloud      -> server
CNAME   www.onshell.cloud  -> onshell.cloud
```

   One host serves everything: Nginx routes `/api` to the API and `/gateway` to
   the gateway, which needs `Upgrade`/`Connection` headers and a long
   `proxy_read_timeout` for the terminal and agent WebSockets. Because it is all
   one origin, the session cookie is first-party and there is no cross-site
   request for a browser to reason about.

3. Set production environment variables (see `.env.example`; `SITE_URL`,
   `API_BASE_URL`, `GATEWAY_BASE_URL`, and `CORS_ORIGINS` all default to the
   `onshell.cloud` values when `NODE_ENV=production`).
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
9. Configure SMTP from `/admin` → Settings → SMTP.
10. Configure package prices and payment provider from `/admin` → Settings.
11. Add the Cloudflare Turnstile key pair in `/admin` → Settings → Bot Protection,
    then enable it. Verification fails closed, so enabling without both keys is
    rejected rather than silently bypassed.
12. Add an OpenAI API key in `/admin` → Settings → AI Assistant to switch the
    in-product assistant on. Use "Send test prompt" to confirm the key works.
13. Schedule database backups:

```bash
yarn db:backup
```

## Admin Capabilities

The admin panel is designed for business operations:

* Manage SaaS packages and pricing, including which tier is the free plan and which
  card is highlighted on the public pricing grid
* Manage users and platform-admin access
* Read and triage the **Inbox** of contact-form enquiries (status, internal notes)
* Review **AI conversations** across all workspaces for support and abuse handling
  (opening a thread is itself audit-logged)
* Track the **Growth** funnel: free vs paid workspaces, conversion rate, referral
  leaderboard, and newsletter subscribers
* Configure SMTP for invitations, resets, invoices, and alerts
* Configure Cloudflare Turnstile bot protection per public form
* Configure the OpenAI-powered AI assistant (model, prompt, quotas)
* Configure payment provider settings
* Review subscriptions and usage
* Manage brand/platform settings
* Monitor hosts, sessions, and audit activity

## Importing Hosts From Other Tools

**Console → Hosts → Import / Export.** Drop in a file or paste its contents; the
format is detected from the content (not the extension, which people rename), and
nothing is written until you review the preview.

| Source | Format | Notes |
| --- | --- | --- |
| Termius | JSON or CSV export | Nested `group` / `identity` objects and tag objects are read |
| OpenSSH | `~/.ssh/config` | `HostName`, `Port`, `User`; wildcard blocks are skipped and reported |
| PuTTY | `.reg` registry export | `%20`-encoded session names and `dword:` hex ports decoded; serial sessions skipped |
| Windows RDP | `.rdp` file | Filename becomes the label; `DOMAIN\user` split; several files can be pasted together |
| RDCMan | `.rdg` file | Nested groups become host groups; `displayName` preferred over the address |
| Anything else | CSV / TSV | Fuzzy header matching — `label`/`name`, `hostname`/`address`/`ip`, `port`, `username`, `tags`, `group`, `notes` |
| Onshell.cloud | JSON export | Round-trips its own export |

The preview shows, per row, whether it will be created, already exists
(address + port + username is the identity), or is a duplicate inside the file — plus
bulk overrides for environment, group, and tags before you commit. Plan `maxHosts`
is enforced, and a grant-governed role automatically receives access to what it
imports. Import and export are both audit-logged.

Export writes JSON (re-importable), CSV (opens in Excel, imports into Termius), or an
`ssh-config` fragment. **Credentials are never exported** — they stay encrypted in the
vault — and CSV cells beginning `=`, `+`, `-`, or `@` are prefixed so a hostname cannot
become a formula when the file is opened in a spreadsheet.

## API Highlights

Public:

```text
GET  /plans
GET  /public/site-config     # Turnstile site key + AI availability, read at runtime
POST /checkout               # Turnstile-guarded
POST /contact                # Turnstile-guarded, rate limited
POST /newsletter             # Turnstile-guarded, rate limited
```

Auth and console:

```text
GET  /auth/me
POST /auth/register
POST /auth/login
GET  /hosts
POST /hosts
POST /hosts/import/preview   # dry run: what an import would do
POST /hosts/import           # apply
GET  /hosts/export           # ?format=json|csv|ssh-config
GET  /sessions
POST /sessions
GET  /snippets
GET  /audit
GET  /me/growth              # plan, live usage vs limits, upgrade path, referral link
GET  /ai/status
GET  /ai/threads
GET  /ai/threads/:threadId
POST /ai/messages
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
GET   /admin/turnstile
PATCH /admin/turnstile
GET   /admin/ai/settings
PATCH /admin/ai/settings
POST  /admin/ai/test
GET   /admin/ai/threads
GET   /admin/ai/threads/:threadId
GET   /admin/contact-messages
PATCH /admin/contact-messages/:messageId
GET   /admin/growth
```

Auth and 2FA:

```text
POST /auth/login
POST /auth/2fa/setup
POST /auth/2fa/verify
POST /auth/2fa/complete
POST /auth/2fa/email/enable
POST /auth/2fa/email/challenge   # code needed to turn email 2FA OFF
POST /auth/2fa/email/verify
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
GOOGLE_REDIRECT_URI=https://onshell.cloud/api/auth/google/callback
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

Implemented (verified 2026-07-10 — see PROJECT_PLAN.md section 13 for the full audit):

* Yarn workspace monorepo
* Redesigned public SaaS landing page (terminal hero, pricing wired to `/plans` and `/checkout`)
* Customer console: Termius-style workspace with live xterm.js SSH terminal tabs over the gateway WebSocket, SFTP browser, encrypted credential vault, snippets, team management, audit log, theming (Forest/Slate/Carbon), Framer Motion transitions
* Admin panel: functional sections for overview, packages, subscriptions, users, SMTP, billing provider, and platform settings with loading/error/toast states
* Auth: register/login with strong password policy, 2FA via Google Authenticator (TOTP) or email OTP, Google OAuth, refresh-token rotation (`/auth/refresh`), password reset via email OTP
* Teams: real invitations (emailed accept links), member role management, last-owner protection
* Resource APIs backed by Prisma with real JWT auth (hosts with groups/tags, encrypted credentials, sessions with API→gateway handoff, snippets, unified audit log)
* Gateway: real SSH terminal (ssh2 + PTY over WebSocket), guacd RDP protocol bridge, SFTP directory listing
* PWA: web manifest, installable icons, standalone display
* Prisma schema, migration, and seed
* Docker Compose infrastructure

Added 2026-07-26:

* Freemium pricing: a permanent Free tier for solo users, auto-assigned on signup,
  plus Team and Business paid tiers
* Cloudflare Turnstile on signup, sign-in, password reset, contact, checkout, and
  newsletter, with credentials and per-form toggles managed from `/admin`
* Contact-us page and an admin inbox with status triage and internal notes
* OpenAI-powered AI assistant with persisted threads, per-plan monthly quotas, and
  admin review of all conversations
* Growth surfaces: plan/usage meters, upgrade nudges, referral programme with
  shareable links, and newsletter capture
* Session-aware public pages (avatar + menu when a visitor already has a session)
* SEO/AI-SEO: repositioned copy, a `/browser-ssh-client` pillar page, `/security`,
  expanded JSON-LD (`SoftwareApplication`, `HowTo`, `FAQPage`, `BreadcrumbList`),
  `llms.txt`, `security.txt`, and an AI-crawler allowlist in `robots.txt`
* Security hardening: production secret guards, constant-time token comparison,
  per-account login lockout, per-route rate limits, TTL-bounded challenge stores,
  no internal error leakage, CSP and security headers, and removal of hardcoded
  development credentials

Pending production work (Phase B/C in PROJECT_PLAN.md):

* Full SFTP file operations (upload/download/rename/delete/edit) and the browser RDP viewer UI
* Billing webhooks (subscription/invoice rows) and plan-limit enforcement
* Snippet variables
* Expand gateway tests with disposable SSH/RDP containers
* Add production observability

Added — the desktop app (`apps/desktop`, see [docs/desktop.md](docs/desktop.md)):

* Electron client with a locally bundled renderer — it never loads remote code
* This machine's own terminal via `node-pty`, working with the network unplugged
* Direct SSH/SFTP from the user's machine, with short-lived audited credential leases
* Relay fallback through the gateway, offered rather than silently substituted
* Dual-pane file transfer between this computer and a host
* Enrolled-device list, so credential handouts are visible and revocable per machine
* "Share this computer" mode, which retires `apps/agent-desktop` into one installer
* Signed installers for Windows, macOS, and Linux from a public build workflow

## Self-Hosting

Everything needed to run your own Onshell is in this repository: the Compose file, the
migrations, the seed, and the deployment guide. There is no licence key, no phone-home,
and no feature held back for the hosted version.

```bash
git clone https://github.com/latifurrahmanlemon/onshell.cloud.git
cd onshell.cloud
corepack enable && yarn install
cp .env.example .env    # then set JWT_SECRET and MASTER_ENCRYPTION_KEY
docker compose up -d mysql redis guacd
yarn db:generate && yarn db:migrate && yarn db:seed
yarn dev
```

Generate real secrets with `openssl rand -base64 48`. The API refuses to start in
production while `JWT_SECRET` or `MASTER_ENCRYPTION_KEY` still hold their placeholder
values — that guard is deliberate, and it is in
[packages/config/src/index.ts](packages/config/src/index.ts) if you want to see it.

Two things to get right before pointing real servers at it:

1. **Keep the gateway private.** It performs no authorisation. Set
   `GATEWAY_SHARED_SECRET` and do not publish its port.
2. **Back up `MASTER_ENCRYPTION_KEY` separately from the database.** Together they open
   the vault; the key alone opens nothing, and the database alone is ciphertext. Lose
   the key and every saved credential is unrecoverable — which is the point.

The desktop app's server URL is a setting, so the same signed installer works against
your deployment.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Small, single-purpose pull requests; `yarn
typecheck && yarn lint && yarn test` before opening one. There is no CLA — contributors
keep their copyright, and nobody, including the maintainers, can relicense the project
out from under them.

Changes to the credential vault, the lease path, authentication, RBAC, the agent's
consent logic, the desktop IPC boundary, or the update channel get a slower and more
suspicious review. That is the point of the project, not distrust of you.

Found a vulnerability? **Do not open an issue.** See [SECURITY.md](SECURITY.md).

## Licence

**GNU Affero General Public License v3.0** — see [LICENSE](LICENSE).

In plain terms: run it, read it, change it, and share it freely. If you distribute a
modified version, or run one as a service other people use, those people are entitled
to your version's source under the same licence.

The name and brand are not covered — see [NOTICE](NOTICE). Fork the code as much as you
like; use your own name when you offer it publicly, so nobody is misled about whose
software is holding their credentials.
