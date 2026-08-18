# Deploying Onshell on CloudPanel

A step-by-step runbook for hosting the whole stack — Next.js web, Fastify API,
gateway, MySQL, Redis — behind one domain on a CloudPanel VPS.

`onshell.cloud` is used throughout as the example domain. Substitute your own; the
only place it genuinely matters is the `.env` and the Nginx vhost.

## Architecture (single domain, path routing)

All traffic arrives on one domain, and CloudPanel's Nginx routes it to three Node
processes:

```
                         https://onshell.cloud   (CloudPanel Nginx + Let's Encrypt SSL)
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        │ location /                    │ location /api/                │ location /gateway/
        ▼                               ▼                               ▼
   127.0.0.1:5018                  127.0.0.1:5017                  127.0.0.1:5019
   onshell-web (Next.js)           onshell-api (Fastify)           onshell-gateway (WS/SSH/RDP)
                                        │                               │
                                   127.0.0.1:3306 (MySQL)          guacd (optional, RDP)
                                   127.0.0.1:6379 (Redis)
```

- The Node processes listen on `127.0.0.1` only — nothing reaches them from outside.
  Only `80/443` are public.
- The browser calls `https://onshell.cloud/api/...`, and Nginx strips the `/api`
  prefix before forwarding.
- Same origin throughout, so the session cookie is first-party and there is no
  cross-site request for a browser to reason about.

**The gateway must not be published on its own port.** It performs no
authorisation — access control lives entirely in the API — so it is only safe
behind this proxy, on loopback, with `GATEWAY_SHARED_SECRET` set. See
[architecture.md](architecture.md).

---

## 0. Prerequisites

- A CloudPanel VPS (Ubuntu 22.04/24.04) with root or sudo, and SSH access.
- DNS control for the domain.
- On the VPS: **Node.js 22**, **MySQL 8** (CloudPanel provides it), **Redis**, and
  **guacd** (Docker) if you want the RDP feature.

---

## 1. DNS

At your DNS provider, create an **A record** pointing at the VPS:

| Type | Name  | Value             | Proxy/TTL       |
|------|-------|-------------------|-----------------|
| A    | `@`   | `<VPS_PUBLIC_IP>` | DNS only / Auto |

> On Cloudflare, start with **DNS only (grey cloud)** so Let's Encrypt can issue the
> certificate. Turn the proxy on afterwards.

Verify with `dig +short onshell.cloud`.

---

## 2. Install Redis

Redis backs session coordination, rate limiting, and gateway state:

```bash
sudo apt update
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
redis-cli ping     # => PONG
```

Redis listens on `127.0.0.1:6379` by default, which is what we want.

---

## 3. Create the MySQL database

CloudPanel UI → **Databases** → **Add Database**:

- **Database Name:** `onshell_cloud`
- **Username:** `onshell`
- **Password:** a strong one — write it down

CloudPanel's MySQL runs on localhost `3306`, so the connection string is:

```
mysql://onshell:<DB_PASSWORD>@127.0.0.1:3306/onshell_cloud
```

> ⚠️ Special characters in the password (`@ : / # ? %` …) must be URL-encoded — `@`
> becomes `%40`. Restricting the password to letters and digits avoids the whole
> problem.

---

## 4. Create the Node.js site

CloudPanel UI → **Sites** → **Add Site** → **Create a Node.js Site**:

- **Domain Name:** `onshell.cloud`
- **Node.js Version:** `22`
- **App Port:** `5018` — the web app will listen here
- **Site User:** `onshell` (a system user is created)
- **Site User Password:** write it down

CloudPanel then creates:

- a Linux user and home directory at `/home/onshell/htdocs/onshell.cloud`
- an Nginx vhost reverse-proxying `443/80` → `127.0.0.1:5018`, which we edit in step 9
  to add `/api` and `/gateway`

> Button and tab names vary slightly between CloudPanel versions; the steps are the
> same.

---

## 5. Runtime setup (Node 22, Yarn, PM2)

SSH in as the site user (or `su - onshell` from root):

```bash
ssh onshell@<VPS_PUBLIC_IP>
```

Set up Node 22, Corepack (Yarn 4), and PM2 once for this user:

```bash
# nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"

# Node 22 + Yarn 4 (corepack) + PM2
nvm install 22
nvm alias default 22
corepack enable
npm install -g pm2

node -v   # v22.x
yarn -v   # 4.x — the repo pins 4.6.0, which activates inside the checkout
pm2 -v
```

---

## 6. Clone the code and write `.env`

```bash
cd ~/htdocs/onshell.cloud
# Clone straight into htdocs if it is empty, or clone to a temp dir and move the
# contents in:
git clone https://github.com/latifurrahmanlemon/onshell.cloud.git .
```

Create the production `.env` at the repository root:

```bash
cp .env.example .env
nano .env
```

Set these values (the public URLs follow your domain):

```env
NODE_ENV=production
LOG_LEVEL=info

# Every Node service binds to localhost only; Nginx proxies from outside.
HOST=127.0.0.1

# Internal ports each service listens on, which Nginx proxies to. These match the
# defaults in ecosystem.config.cjs, so the lines are optional.
WEB_PORT=5018
API_PORT=5017
GATEWAY_PORT=5019

# Public base URLs — single domain, path routing
PUBLIC_BASE_URL=https://onshell.cloud
API_BASE_URL=https://onshell.cloud/api
GATEWAY_BASE_URL=https://onshell.cloud/gateway

# Baked into the Next.js client bundle at build time
NEXT_PUBLIC_API_BASE_URL=https://onshell.cloud/api
NEXT_PUBLIC_GATEWAY_BASE_URL=https://onshell.cloud/gateway

# Database (CloudPanel MySQL) and Redis
DATABASE_URL=mysql://onshell:<DB_PASSWORD>@127.0.0.1:3306/onshell_cloud
REDIS_URL=redis://127.0.0.1:6379

# Secrets — these must be changed. The API refuses to boot in production while
# they still hold their .env.example placeholders.
JWT_SECRET=<long-random-string>
MASTER_ENCRYPTION_KEY=<32-byte-base64-key>
CORS_ORIGINS=https://onshell.cloud

# Shared secret between the API and the gateway. The **same** value in both.
# Leaving it empty leaves the gateway's REST routes unauthenticated — anyone who
# knows a session id could list that session's files. The browser never calls the
# gateway's REST API directly, so setting it breaks nothing.
GATEWAY_SHARED_SECRET=<32-byte-hex>

# Escape hatch for a misconfigured Turnstile locking everyone out. Normally false.
TURNSTILE_DISABLED=false

# Seed admin account
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=<strong-admin-password>

# Google OAuth (optional; leave empty if unused)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://onshell.cloud/api/auth/google/callback

# SMTP (optional)
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM_EMAIL=noreply@onshell.cloud
SMTP_FROM_NAME=Onshell

# guacd, if you are running the RDP feature; otherwise leave the defaults
GUACD_HOST=127.0.0.1
GUACD_PORT=4822
```

Generating the secrets:

```bash
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 32   # MASTER_ENCRYPTION_KEY
openssl rand -hex 32      # GATEWAY_SHARED_SECRET
```

> **Back up `MASTER_ENCRYPTION_KEY` separately from the database.** Together they
> open the credential vault; the key alone opens nothing, and the database alone is
> ciphertext. Lose the key and every saved credential is unrecoverable — which is
> the point.

> **Why `set -a && source .env` before building or starting:** the `NEXT_PUBLIC_*`
> variables are baked into the web bundle during `yarn build`, and PM2 reads secrets
> from the shell environment at start. So load `.env` into the shell before either.

---

## 7. Install, build, migrate, seed

```bash
cd ~/htdocs/onshell.cloud
set -a && source .env && set +a      # load .env into the shell environment

# The Prisma CLI runs from apps/api/, so symlink the root .env there once. Without
# it db:generate / db:deploy / db:seed cannot see DATABASE_URL.
ln -sf ../../.env apps/api/.env

corepack enable
yarn install --immutable
yarn build                            # packages + api/gateway dist + web .next
yarn db:generate                      # Prisma client (MySQL)
yarn db:deploy                        # apply migrations
yarn db:seed                          # admin, plans, settings
```

> **`Environment variable not found: DATABASE_URL`?** The `yarn db:*` scripts run in
> `apps/api/`, where Prisma cannot see the root `.env`. The `ln -sf ../../.env
> apps/api/.env` above fixes it permanently; `set -a && source .env && set +a` before
> each command works too.

On success you will have `apps/api/dist`, `apps/gateway/dist`, and `apps/web/.next`,
with the tables and the admin account in the database.

---

## 8. Run the three services under PM2

The repository ships `ecosystem.config.cjs` (web 5018, api 5017, gateway 5019). It
loads the root `.env` itself, so sourcing it separately is not required — anything
already set in the shell takes precedence:

```bash
cd ~/htdocs/onshell.cloud
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs                              # all three services
```

Three processes should show `online`: `onshell-web`, `onshell-api`,
`onshell-gateway`.

**Surviving a reboot** (systemd). `pm2 startup` needs root:

```bash
# As the site user — this prints a sudo command:
pm2 startup

# Run the printed command as root, for example:
sudo env PATH=$PATH:/home/onshell/.nvm/versions/node/v22.*/bin \
    pm2 startup systemd -u onshell --hp /home/onshell

# Then save the current process list, as the site user:
pm2 save
```

---

## 9. Edit the Nginx vhost to add `/api` and `/gateway`

CloudPanel UI → **Sites** → `onshell.cloud` → **Vhost** tab.

The default vhost has only `location / { ... :5018 }`. Inside the HTTPS `server { }`
block, alongside `location / { }`, add these two:

```nginx
    # API (Fastify) — /api/* -> :5017, with the /api prefix stripped
    location /api/ {
        proxy_pass http://127.0.0.1:5017/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 25m;
    }

    # Gateway (WebSocket + REST) — /gateway/* -> :5019, prefix stripped
    location /gateway/ {
        proxy_pass http://127.0.0.1:5019/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
```

The long `proxy_read_timeout` matters: terminal and agent WebSockets stay open with
no traffic for long stretches, and the default would cut them.

Confirm `location / { }` points at `127.0.0.1:5018` — it will already, if you gave
port 5018 when creating the site:

```nginx
    location / {
        proxy_pass http://127.0.0.1:5018;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
```

On save, CloudPanel tests the config and reloads Nginx. If it errors, check where the
blocks were placed and that the braces balance.

> **Why this works:** the trailing `/` on `proxy_pass` makes Nginx strip the matched
> prefix and forward the rest — `/api/auth/login` arrives at the API as
> `/auth/login`, and `/gateway/sessions` arrives at the gateway as `/sessions`. Nginx
> matches the longest prefix, so `/api` and `/gateway` win and everything else falls
> through to `/`.

---

## 10. SSL (Let's Encrypt)

CloudPanel UI → **Sites** → `onshell.cloud` → **SSL/TLS** → **Actions → New Let's
Encrypt Certificate** → **Create and Install**.

With DNS pointing correctly it issues in seconds and enables the HTTP→HTTPS
redirect. (Issuance can fail while a Cloudflare proxy is on — keep the grey cloud
until it succeeds.)

---

## 11. Verify

From the VPS:

```bash
curl -s http://127.0.0.1:5018 | head -c 200      # web
curl -s http://127.0.0.1:5017/health             # api     => {"status":"ok",...}
curl -s http://127.0.0.1:5019/health             # gateway
```

From outside, through the path routing:

```bash
curl -s https://onshell.cloud/api/health     # => API health JSON
curl -s https://onshell.cloud/gateway/health # => gateway health JSON
curl -sI https://onshell.cloud               # => 200, Next.js web
```

Then open `https://onshell.cloud/login` in a browser and sign in with the seeded
admin (`ADMIN_EMAIL` / `ADMIN_PASSWORD`). In DevTools → Network, confirm the API
calls are going to `https://onshell.cloud/api/...`.

---

## 12. Firewall

Keep only web and SSH public; the app ports stay on loopback:

```bash
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
sudo ufw status
```

`HOST=127.0.0.1` in `.env` already keeps the Node processes off the public
interface; ufw is the second layer.

---

## 13. Google OAuth (optional)

Google Cloud Console → OAuth client → **Authorized redirect URIs**, add:

```
https://onshell.cloud/api/auth/google/callback
```

Then set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in
`.env` and rebuild/restart (step 14).

---

## 14. Updating / redeploying

```bash
cd ~/htdocs/onshell.cloud
set -a && source .env && set +a
git pull
yarn install --immutable
yarn build
yarn db:deploy         # if there are new migrations
pm2 reload ecosystem.config.cjs   # near-zero-downtime restart
pm2 logs
```

> Changing any `NEXT_PUBLIC_*` value requires a fresh `yarn build` — otherwise the
> old URL stays baked into the bundle.

---

## 15. RDP feature (guacd — optional)

RDP through the browser needs guacd. Docker is the simplest route:

```bash
sudo apt install -y docker.io
sudo docker run -d --name guacd --restart unless-stopped -p 127.0.0.1:4822:4822 guacamole/guacd:1.5.5
```

Keep `GUACD_HOST=127.0.0.1` and `GUACD_PORT=4822` in `.env`, then restart the
gateway. Skip this step entirely if you do not need RDP.

---

## 16. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `502 Bad Gateway` | A PM2 process is down, or the port is wrong. Check `pm2 status` and `pm2 logs onshell-web`, and confirm the vhost ports (5018/5017/5019). |
| `525 SSL handshake failed` | A Cloudflare error: TLS between Cloudflare and the origin failed. Usually the proxy (orange cloud) is on but the origin has no valid certificate — Let's Encrypt could not issue because the grey cloud was never set — or the SSL/TLS mode is wrong. The main page may load from cache while `/api/*` hits the origin, which is why the 525 shows up there first. **Fix:** grey cloud, issue Let's Encrypt (step 10), **or** install a Cloudflare Origin Certificate; then set SSL/TLS mode to **Full (strict)**. Do not use "Flexible". Test the origin directly with `curl -sv --resolve onshell.cloud:443:<VPS_PUBLIC_IP> https://onshell.cloud/api/health`. |
| Web loads but login/API fails | `NEXT_PUBLIC_API_BASE_URL` is wrong or was not baked in. Fix `.env` and run `yarn build` again. Check the actual request URL in DevTools. |
| `P1001: can't reach database` | Wrong `DATABASE_URL`, MySQL down, or an un-encoded special character in the password. Test with `mysql -u onshell -p onshell_cloud`. |
| Migration fails / access denied | Check the database user's privileges in CloudPanel and that the host is `127.0.0.1`. |
| `P3009: migrate found failed migrations` | A migration failed earlier, so Prisma will not run any others. See **16.1**. |
| Redis errors | Confirm `redis-cli ping` answers `PONG` and that `REDIS_URL` is right. |
| WebSocket (gateway) will not connect | Check the `/gateway/` location has the `Upgrade` and `Connection "upgrade"` headers, and that WebSockets are allowed if Cloudflare is proxying. |
| Everything stops after a reboot | `pm2 startup` (as root) and `pm2 save` were not run — see step 8. |

---

## 16.1 Recovering from `P3009`

```text
Error: P3009
migrate found failed migrations in the target database
The `2026...._xxx` migration started at ... failed
```

Prisma leaves the failed migration in `_prisma_migrations` with `finished_at = NULL`
and refuses to run anything after it. **Find out why it failed first** — resolving
without knowing leaves the schema and the migration history disagreeing.

**Step 1 — read the real error and the database's current state**

```bash
cd /home/onshell/htdocs/onshell.cloud

# Prisma records the actual error in the database itself
mysql -u onshell -p onshell_cloud -e "
  SELECT migration_name, started_at, finished_at, rolled_back_at, logs
  FROM _prisma_migrations ORDER BY started_at DESC LIMIT 3\G"
```

**Step 2 — check how much of it actually applied**

DDL is **not** transactional in MySQL, so a migration can stop halfway. Open the
file and check each statement's effect against the database, for example:

```bash
mysql -u onshell -p onshell_cloud -e "SHOW TABLES LIKE 'Agent%'; SHOW COLUMNS FROM \`Host\` LIKE 'isAgent';"
```

* **Nothing applied** (empty result) → go to step 3.
* **Partially applied** → undo what did apply by hand (`DROP TABLE`, `ALTER TABLE …
  DROP COLUMN`) so the migration can run from the start. Without this it fails again
  with `Duplicate column name` or `Table already exists`.

**Step 3 — fix the cause, mark it rolled back, run again**

```bash
git pull                       # the fix

yarn workspace @onshell/api prisma migrate resolve \
  --rolled-back 20260731174638_add_agent_devices

yarn db:deploy
yarn db:status                 # should say "Database schema is up to date!"
```

`--rolled-back` only records "that attempt did not happen" — it undoes nothing in
the database itself, which is why step 2 comes first. Do **not** use `--applied`
unless you ran the whole SQL by hand; otherwise Prisma believes the work is done and
those columns are never created.

**Step 4 — restart the services**

```bash
yarn install                   # includes node-pty's postinstall chmod
yarn build
pm2 restart ecosystem.config.cjs --update-env
```

### Why this happened once (2 August 2026)

`20260731174638_add_agent_devices` was written as ``ALTER TABLE `host` `` — lower
case — while the table is really `Host`. MySQL on macOS and Windows runs with
`lower_case_table_names` set to 1 or 2, so the case mismatch passes there. On Linux
the default is **0**, meaning case-sensitive, and it failed with
`Table 'onshell.host' doesn't exist`.

So that this cannot reach a server again, `yarn check:migrations`
(`scripts/check-migration-case.mjs`) verifies the table-name case in every migration,
and CI runs `yarn db:deploy` against MySQL on Linux.

---

## Reference: default ports

| Service | PM2 name | Internal port | Public path |
|---|---|---|---|
| Web (Next.js) | `onshell-web` | 5018 | `/` |
| API (Fastify) | `onshell-api` | 5017 | `/api` |
| Gateway (WS/SSH/RDP) | `onshell-gateway` | 5019 | `/gateway` |
| MySQL | (CloudPanel) | 3306 | internal only |
| Redis | (system) | 6379 | internal only |

---

## Alternative: a subdomain per service

Instead of path routing you can give each service its own subdomain — cleaner
separation, at the cost of three sites and three certificates:

- `onshell.cloud` → web (5018)
- `api.onshell.cloud` → api (5017)
- `gateway.onshell.cloud` → gateway (5019)

Then set `API_BASE_URL` and `NEXT_PUBLIC_API_BASE_URL` to `https://api.onshell.cloud`
(no path prefix) and create a separate **Reverse Proxy Site** in CloudPanel for each.
For most deployments the single-domain approach above is simpler and enough.

**Do not give the gateway a public subdomain unless you have set
`GATEWAY_SHARED_SECRET`.** It authorises nothing on its own.
