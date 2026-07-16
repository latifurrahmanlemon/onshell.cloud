# Deploy onshell.cloud on CloudPanel — `web.onshell.cloud`

CloudPanel (VPS + root/SSH) এর উপর পুরো stack (Next.js web + Fastify API + Gateway + MySQL + Redis) কীভাবে
একটা subdomain `web.onshell.cloud` এ host করবে, তার step-by-step runbook।

## Architecture (single subdomain, path routing)

সব traffic একটাই domain দিয়ে ঢুকবে; CloudPanel এর Nginx সেটা ভেতরের ৩টা Node process এ route করবে:

```
                         https://web.onshell.cloud   (CloudPanel Nginx + Let's Encrypt SSL)
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        │ location /                     │ location /api/                 │ location /gateway/
        ▼                               ▼                               ▼
   127.0.0.1:5018                  127.0.0.1:5017                  127.0.0.1:5019
   onshell-web (Next.js)           onshell-api (Fastify)           onshell-gateway (WS/SSH/RDP)
                                        │                               │
                                   127.0.0.1:3306 (MySQL)          guacd (optional, RDP)
                                   127.0.0.1:6379 (Redis)
```

- Node process গুলো শুধু `127.0.0.1` এ listen করে — বাইরে থেকে সরাসরি reachable নয়। শুধু `80/443` public.
- Browser-এর API call যায় `https://web.onshell.cloud/api/...` এ, Nginx সেটা `/api` prefix বাদ দিয়ে API তে পাঠায়।
- Same-origin, তাই JWT cookie আর CORS নিয়ে বাড়তি ঝামেলা নেই।

---

## 0. Prerequisites

- CloudPanel-installed VPS (Ubuntu 22.04/24.04), root বা sudo + SSH access।
- DNS control for `onshell.cloud`.
- এই services গুলো VPS-এ লাগবে: **Node.js 22**, **MySQL 8** (CloudPanel দেয়), **Redis**, এবং RDP feature লাগলে **guacd** (Docker)।

---

## 1. DNS — subdomain point করা

তোমার DNS provider (Cloudflare/registrar) এ `onshell.cloud`-এর অধীনে একটা **A record** বানাও:

| Type | Name              | Value            | Proxy/TTL          |
|------|-------------------|------------------|--------------------|
| A    | `web`             | `<VPS_PUBLIC_IP>`| DNS only / Auto    |

> Cloudflare ব্যবহার করলে প্রথমে **DNS only (grey cloud)** রাখো যাতে Let's Encrypt issue করা যায়। SSL ঠিকমতো হওয়ার পর orange cloud (proxy) অন করতে পারো।

`dig +short web.onshell.cloud` দিয়ে verify করো IP ঠিক আসছে কিনা।

---

## 2. Redis install (VPS-এ, একবার)

App সেশন/rate-limit/gateway coordination এর জন্য Redis লাগে:

```bash
sudo apt update
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
redis-cli ping     # => PONG
```

Redis default-এ শুধু `127.0.0.1:6379` এ listen করে — সেটাই আমাদের দরকার।

---

## 3. CloudPanel-এ MySQL database বানানো

CloudPanel UI → **Databases** → **Add Database**:

- **Database Name:** `onshell_cloud`
- **Username:** `onshell`
- **Password:** একটা strong password দাও (নোট করে রাখো)

CloudPanel MySQL localhost `3306` এ চলে। এই থেকে connection string হবে:

```
mysql://onshell:<DB_PASSWORD>@127.0.0.1:3306/onshell_cloud
```

> ⚠️ Password-এ special character (`@ : / # ? %` ইত্যাদি) থাকলে URL-encode করতে হবে (যেমন `@` → `%40`)। ঝামেলা এড়াতে password-এ শুধু letters+digits রাখলে সহজ।

---

## 4. CloudPanel-এ Node.js Site বানানো

CloudPanel UI → **Sites** → **Add Site** → **Create a Node.js Site**:

- **Domain Name:** `web.onshell.cloud`
- **Node.js Version:** `22`
- **App Port:** `5018`  ← আমাদের web app এই port-এ চলবে
- **Site User:** `onshell` (একটা system user তৈরি হবে)
- **Site User Password:** নোট করে রাখো

Create করলে CloudPanel:
- একটা Linux user + home dir বানায়: `/home/onshell/htdocs/web.onshell.cloud`
- একটা Nginx vhost বানায় যেটা `443/80` → `127.0.0.1:5018` reverse-proxy করে (এটা আমরা পরে edit করে `/api` আর `/gateway` যোগ করবো)।

> Button/tab-এর নাম CloudPanel version ভেদে সামান্য আলাদা হতে পারে, কিন্তু ধাপগুলো একই।

---

## 5. SSH + runtime (Node 22, Yarn, PM2)

Site user হিসেবে SSH করো (অথবা root এ ঢুকে `su - onshell`):

```bash
ssh onshell@<VPS_PUBLIC_IP>
```

nvm দিয়ে Node 22 + corepack(Yarn 4) + PM2 setup (এই user এর জন্য একবার):

```bash
# nvm install
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"

# Node 22 + Yarn 4 (corepack) + PM2
nvm install 22
nvm alias default 22
corepack enable
npm install -g pm2

node -v   # v22.x
yarn -v   # 4.x (repo-তে ঢুকলে 4.6.0 activate হবে)
pm2 -v
```

---

## 6. কোড আনা + `.env` বানানো

```bash
cd ~/htdocs/web.onshell.cloud
# htdocs খালি থাকলে সরাসরি এখানে clone করো (অথবা temp-এ clone করে content move করো):
git clone <YOUR_REPO_URL> .
```

Repo root-এ production `.env` বানাও:

```bash
cp .env.example .env
nano .env
```

`.env`-এ এই মানগুলো বসাও (public URL গুলো subdomain অনুযায়ী):

```env
NODE_ENV=production
LOG_LEVEL=info

# সব Node service শুধু localhost-এ bind করবে (Nginx বাইরে থেকে proxy করে)
HOST=127.0.0.1

# প্রতিটা Node service যে internal port-এ listen করবে (Nginx এগুলোতে proxy করে)।
# ecosystem.config.cjs-এর default এগুলোর সাথেই মেলানো, তাই এই লাইনগুলো optional।
WEB_PORT=5018
API_PORT=5017
GATEWAY_PORT=5019

# Public base URLs — single subdomain, path routing
PUBLIC_BASE_URL=https://web.onshell.cloud
API_BASE_URL=https://web.onshell.cloud/api
GATEWAY_BASE_URL=https://web.onshell.cloud/gateway

# Web (Next.js) client bundle — build time-এ bake হয়
NEXT_PUBLIC_API_BASE_URL=https://web.onshell.cloud/api
NEXT_PUBLIC_GATEWAY_BASE_URL=https://web.onshell.cloud/gateway

# Database (CloudPanel MySQL) + Redis
DATABASE_URL=mysql://onshell:<DB_PASSWORD>@127.0.0.1:3306/onshell_cloud
REDIS_URL=redis://127.0.0.1:6379

# Secrets — অবশ্যই বদলাও
JWT_SECRET=<long-random-string>
MASTER_ENCRYPTION_KEY=<32-byte-base64-key>
CORS_ORIGINS=https://web.onshell.cloud

# Admin seed account
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=<strong-admin-password>

# Google OAuth (optional; না লাগলে খালি রাখো)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://web.onshell.cloud/api/auth/google/callback

# SMTP (optional)
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM_EMAIL=noreply@onshell.cloud
SMTP_FROM_NAME=Onshell

# Guacd (RDP feature চালালে; নাহলে default রাখো)
GUACD_HOST=127.0.0.1
GUACD_PORT=4822
```

Random secret বানানোর সহজ উপায়:

```bash
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 32   # MASTER_ENCRYPTION_KEY
```

> **কেন `set -a && source .env` করে build/start করতে হবে:** `NEXT_PUBLIC_*` variable গুলো `yarn build` এর সময় web bundle-এ **bake** হয়ে যায়, আর PM2 ও start-এর সময় shell env থেকে secret নেয়। তাই প্রতিবার build/start করার আগে `.env` কে shell-এ load করবো।

---

## 7. Install → Build → Migrate → Seed

```bash
cd ~/htdocs/web.onshell.cloud
set -a && source .env && set +a      # .env কে shell env-এ load করো

# Prisma CLI apps/api/ থেকে run হয়, তাই root .env এর একটা symlink দিয়ে দাও
# যাতে db:generate/deploy/seed সব সময় DATABASE_URL পায় (একবারই লাগবে):
ln -sf ../../.env apps/api/.env

corepack enable
yarn install --immutable
yarn build                            # packages + api/gateway dist + web .next
yarn db:generate                      # Prisma client (MySQL)
yarn db:deploy                        # MySQL migration apply
yarn db:seed                          # admin/plans/settings seed
```

> **`Environment variable not found: DATABASE_URL` error?** কারণ `yarn db:*` script গুলো `apps/api/`
> ফোল্ডারে run হয়, আর Prisma root-এর `.env` দেখতে পায় না। উপরের `ln -sf ../../.env apps/api/.env`
> symlink দিলেই ঠিক হয়ে যায় (অথবা প্রতিবার আগে `set -a && source .env && set +a` করলেও চলবে)।

সব সফল হলে `apps/api/dist`, `apps/gateway/dist`, `apps/web/.next` তৈরি হবে এবং DB তে table + admin account বসবে।

---

## 8. PM2 দিয়ে ৩টা service চালানো

Repo-তে already একটা `ecosystem.config.cjs` আছে (web=5018, api=5017, gateway=5019)। এটা
নিজে থেকেই root `.env` load করে নেয়, তাই আলাদা করে source করা লাগে না (shell-এ set করা থাকলে সেটাই অগ্রাধিকার পায়):

```bash
cd ~/htdocs/web.onshell.cloud
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs                              # সব service-এর log
```

তিনটা process `online` দেখালে ঠিক আছে: `onshell-web`, `onshell-api`, `onshell-gateway`।

**Reboot-এর পরও চালু রাখতে** (systemd)। `pm2 startup` এর জন্য root/sudo লাগে:

```bash
# site user হিসেবে চালাও — এটা একটা sudo command print করবে:
pm2 startup

# print হওয়া command-টা root/sudo দিয়ে চালাও, যেমন:
sudo env PATH=$PATH:/home/onshell/.nvm/versions/node/v22.*/bin \
    pm2 startup systemd -u onshell --hp /home/onshell

# তারপর current process list save করো (site user হিসেবে):
pm2 save
```

---

## 9. Nginx vhost edit — `/api` আর `/gateway` route যোগ করা

CloudPanel UI → **Sites** → `web.onshell.cloud` → **Vhost** tab।

ডিফল্ট vhost-এ শুধু `location / { ... :5018 }` আছে। HTTPS `server { }` block-এর ভেতরে, `location / { }` এর **পাশে/উপরে** নিচের দুইটা block যোগ করো:

```nginx
    # API (Fastify) — /api/* -> :5017  (/api prefix স্ট্রিপ হয়)
    location /api/ {
        proxy_pass http://127.0.0.1:5017/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 25m;
    }

    # Gateway (WebSocket + REST) — /gateway/* -> :5019  (/gateway prefix স্ট্রিপ হয়)
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

`location / { }` block-টা যেন `127.0.0.1:5018` এ যায় সেটা confirm করো (Node.js site বানানোর সময় port 5018 দিলে এটা এমনিতেই থাকবে):

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

Save করলে CloudPanel config test করে Nginx reload করে। Error দিলে block-এর বসানোর জায়গা/brace মিলিয়ে দেখো।

> **কেন কাজ করে:** `proxy_pass`-এর শেষে `/` থাকায় Nginx matched prefix (`/api/`, `/gateway/`) কেটে বাকি path পাঠায়। যেমন `/api/auth/login` → API-তে `/auth/login`, আর `/gateway/sessions` → gateway-তে `/sessions`. Nginx longest-prefix match করে, তাই `/api` আর `/gateway` আগে ম্যাচ করে, বাকি সব `/` (web) এ যায়।

---

## 10. SSL (Let's Encrypt)

CloudPanel UI → **Sites** → `web.onshell.cloud` → **SSL/TLS** → **Actions → New Let's Encrypt Certificate** → **Create and Install**।

DNS ঠিকমতো point করা থাকলে কয়েক সেকেন্ডে issue হবে এবং HTTP→HTTPS redirect অন হবে। (Cloudflare proxy অন থাকলে issue fail করতে পারে — আগে grey cloud রাখো।)

---

## 11. Verify (কাজ করছে কিনা)

VPS থেকে internal check:

```bash
curl -s http://127.0.0.1:5018 | head -c 200      # web
curl -s http://127.0.0.1:5017/health             # api  => {"status":"ok",...}
curl -s http://127.0.0.1:5019/health             # gateway
```

বাইরে থেকে (public, path routing সহ):

```bash
curl -s https://web.onshell.cloud/api/health     # => API health JSON
curl -s https://web.onshell.cloud/gateway/health # => gateway health JSON
curl -sI https://web.onshell.cloud               # => 200, Next.js web
```

Browser-এ `https://web.onshell.cloud` খুলে `/login` এ seed করা admin (`ADMIN_EMAIL` / `ADMIN_PASSWORD`) দিয়ে login করে দেখো। Browser DevTools → Network-এ API call গুলো `https://web.onshell.cloud/api/...` এ যাচ্ছে কিনা confirm করো।

---

## 12. Firewall (security)

শুধু web আর SSH public রাখো; app port গুলো (5018/5017/5019) localhost-এই থাকুক:

```bash
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
sudo ufw status
```

`.env`-এ `HOST=127.0.0.1` থাকায় Node process গুলো এমনিতেই বাইরে expose হয় না — ufw সেটার দ্বিতীয় স্তরের সুরক্ষা।

---

## 13. Google OAuth (চালালে)

Google Cloud Console → OAuth client → **Authorized redirect URIs**-এ যোগ করো:

```
https://web.onshell.cloud/api/auth/google/callback
```

আর `.env`-এ `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` বসিয়ে rebuild/restart করো (ধাপ ১৪)।

---

## 14. আপডেট / redeploy (নতুন কোড push করলে)

```bash
cd ~/htdocs/web.onshell.cloud
set -a && source .env && set +a
git pull
yarn install --immutable
yarn build
yarn db:deploy         # নতুন migration থাকলে
pm2 reload ecosystem.config.cjs   # zero-downtime মতো restart
pm2 logs
```

> `.env`-এ `NEXT_PUBLIC_*` বদলালে অবশ্যই `yarn build` আবার চালাতে হবে — নাহলে পুরনো URL bundle-এ থেকে যাবে।

---

## 15. RDP feature (guacd — optional)

RDP-through-browser লাগলে guacd দরকার। সহজ উপায় Docker:

```bash
sudo apt install -y docker.io
sudo docker run -d --name guacd --restart unless-stopped -p 127.0.0.1:4822:4822 guacamole/guacd:1.5.5
```

`.env`-এ `GUACD_HOST=127.0.0.1` আর `GUACD_PORT=4822` রাখো, তারপর gateway restart। RDP না লাগলে এই ধাপ skip করা যায়।

---

## 16. Troubleshooting

| সমস্যা | কারণ / সমাধান |
|---|---|
| `502 Bad Gateway` | PM2 process down বা ভুল port। `pm2 status`, `pm2 logs onshell-web` দেখো; vhost-এর port (5018/5017/5019) মিলিয়ে দেখো। |
| `525 SSL handshake failed` | Cloudflare error — Cloudflare ↔ origin এর মধ্যে TLS handshake ফেল। কারণ: Cloudflare proxy (orange) অন কিন্তু origin-এ valid SSL cert নেই (grey cloud না রেখে Let's Encrypt issue করায় বসেনি), বা SSL/TLS mode ভুল। মূল পেজ cache থেকে load হলেও `/api/*` (dynamic) origin hit করে বলে ওখানেই 525 দেখা যায়। **সমাধান:** grey cloud করে Let's Encrypt issue করো (ধাপ ১০), **অথবা** Cloudflare Origin Certificate origin-এ বসাও; তারপর SSL/TLS mode = **Full (strict)**। "Flexible" ব্যবহার করো না। Verify (Cloudflare bypass করে origin টেস্ট): `curl -sv --resolve web.onshell.cloud:443:<VPS_IP> https://web.onshell.cloud/api/health`। |
| Web খোলে, কিন্তু login/API fail | `NEXT_PUBLIC_API_BASE_URL` ভুল বা build-এ bake হয়নি → `.env` ঠিক করে `yarn build` আবার চালাও। DevTools-এ actual call URL দেখো। |
| `P1001: can't reach database` | `DATABASE_URL` ভুল, MySQL down, বা password-এ special char URL-encode হয়নি। `mysql -u onshell -p onshell_cloud` দিয়ে test করো। |
| Migration fail / access denied | CloudPanel-এ DB user-এর privilege, host `127.0.0.1` ঠিক আছে কিনা দেখো। |
| Redis error | `redis-cli ping` → `PONG` আসছে কিনা; `REDIS_URL` ঠিক আছে কিনা। |
| WebSocket (gateway) connect হয় না | `/gateway/` location-এ `Upgrade`/`Connection "upgrade"` header আছে কিনা; Cloudflare proxy-তে WebSocket allow আছে কিনা। |
| Reboot-এর পর সব বন্ধ | `pm2 startup` (root) + `pm2 save` করা হয়নি — ধাপ ৮ আবার দেখো। |

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

## বিকল্প: প্রতি service-এর জন্য আলাদা subdomain

একটাই path routing-এর বদলে চাইলে আলাদা subdomain-ও করা যায় (cleaner separation, তবে ৩টা site + ৩টা SSL):

- `web.onshell.cloud` → web (5018)
- `api.onshell.cloud` → api (5017)
- `gateway.onshell.cloud` → gateway (5019)

তখন `.env`-এ `API_BASE_URL`/`NEXT_PUBLIC_API_BASE_URL` = `https://api.onshell.cloud` (path prefix ছাড়া) দিতে হবে, আর CloudPanel-এ প্রতিটার জন্য আলাদা **Reverse Proxy Site** বানাতে হবে। বেশিরভাগ ক্ষেত্রে উপরের single-subdomain approach-ই যথেষ্ট আর সহজ।
