# Rollout plan

What is left before the agent is something a customer can install, and who has to do
each part. Written down because most of the remaining work is **not code** — it is
certificates, DNS, and two platforms nobody has run this on yet.

Status of the agent itself is in [agent.md](agent.md#status).

---

## 1. Move production to `onshell.cloud` — ops, now

The repo already assumes the new shape: one host, API under `/api`, gateway under
`/gateway`. The server does not yet.

1. **DNS**

   ```text
   A/AAAA  onshell.cloud      -> server
   CNAME   www.onshell.cloud  -> onshell.cloud
   ```

2. **CloudPanel** — new site for `onshell.cloud`, then **SSL/TLS → New Let's Encrypt
   Certificate**. Follow [deploy-cloudpanel.md](deploy-cloudpanel.md); it now names the
   bare domain throughout.

3. **Nginx vhost** — the `/api/` and `/gateway/` locations from the runbook. The gateway
   block must keep `Upgrade`, `Connection "upgrade"` and `proxy_read_timeout 3600s`, or
   terminals and agent tunnels will be cut every 60 seconds.

4. **`.env` on the server**

   ```bash
   SITE_URL=https://onshell.cloud
   PUBLIC_BASE_URL=https://onshell.cloud
   API_BASE_URL=https://onshell.cloud/api
   GATEWAY_BASE_URL=https://onshell.cloud/gateway
   NEXT_PUBLIC_API_BASE_URL=https://onshell.cloud/api
   NEXT_PUBLIC_GATEWAY_BASE_URL=https://onshell.cloud/gateway
   CORS_ORIGINS=https://onshell.cloud,https://www.onshell.cloud
   GOOGLE_REDIRECT_URI=https://onshell.cloud/api/auth/google/callback
   ```

5. **Rebuild the web app — not optional.**

   ```bash
   yarn build
   pm2 restart ecosystem.config.cjs --update-env
   ```

   `NEXT_PUBLIC_*` values are inlined into the client bundle at build time
   (`apps/web/next.config.mjs`). Editing `.env` and restarting pm2 leaves the **old URLs
   compiled into the JavaScript the browser downloads**, and the console fails with CORS
   errors that look like a server problem. This is the single most likely way this
   migration goes wrong.

6. **Google Cloud Console** — update the authorised redirect URI to
   `https://onshell.cloud/api/auth/google/callback`. No amount of code changes this;
   Google login returns `redirect_uri_mismatch` until it is done by hand.

7. **Keep the old host redirecting.** A 301 from `web.onshell.cloud` to `onshell.cloud`
   costs nothing and saves every stale bookmark and link.

### Verifying it worked

```bash
curl -s https://onshell.cloud/api/health
curl -s https://onshell.cloud/gateway/health
```

Then in a browser: sign in, open a terminal on a host, and check the Network tab shows
requests going to `onshell.cloud/api` — not to the old domain. If they still go to the
old domain, step 5 did not happen.

---

## 2. Certificates — blocked on you

Nothing can ship to a customer without these, and neither can be bought from code.

| What | Why | Roughly |
| --- | --- | --- |
| Windows Authenticode certificate | Without it SmartScreen blocks the download outright. **EV** clears the warning immediately; **OV** has to build reputation over weeks of downloads. | OV ~$200–400/yr, EV ~$400–600/yr — check current pricing |
| Apple Developer Program | Required to notarize. Without it Gatekeeper refuses to open the app at all. | $99/yr |

Once bought, add them as GitHub repository secrets. An unsigned remote-access binary is
indistinguishable from malware to both scanners and users — this is the real gap between
"it builds" and "it ships".

---

## 3. Verify macOS and Linux — blocked on hardware

The agent's POSIX paths are **written but have never executed**: shell discovery,
`/etc/shells`, the LaunchAgent plist, the systemd unit, and the `osascript` / `zenity`
consent prompts.

Every bug found in this project so far was found by *running* it — the ConPTY teardown
noise, the `port: 0` rejection, the drain-listener leak, the `wsl.exe` stub, the
unquoted startup path. None of them showed up in a type check.

So on one Mac and one Linux box:

```bash
yarn agent:build
node dist/agent/<target>/onshell-agent.cjs status     # shells discovered?
node dist/agent/<target>/onshell-agent.cjs service    # sane login item?
node dist/agent/<target>/onshell-agent.cjs pair <code>
node dist/agent/<target>/onshell-agent.cjs run
```

Then from a browser: open a terminal, browse files, and have a *second* account try —
the consent dialog must appear on the machine and deny when nobody answers.

Until that has happened, treat those platforms as unproven in anything customer-facing.

---

## 4. Code still to write

Ordered by what actually blocks a release.

1. **Installers** — MSI (WiX), `.pkg`, `.deb`. Turns `yarn agent:build`'s folder into
   something a person double-clicks. Needs testing on each platform, so it pairs with §3.
2. **Signing in CI** — a step in `.github/workflows/agent-release.yml`. Waits on §2.
   Deliberately absent today rather than present-but-fake.
3. **Tray icon** — the persistent "a session is live" indicator with one-click
   disconnect. Session-start notifications exist; the indicator does not, and
   [agent.md](agent.md#security) calls visibility non-negotiable, so this is a promise
   currently half kept. Suggest Tauri (~5 MB) over Electron (~100 MB) — a hundred
   megabytes for one icon is hard to justify in a program that asks this much trust.
4. **Auto-update** — signature-verified. Cannot be tested before §2.
5. **Download page** on the marketing site.
6. **Multi-gateway routing** via Redis — only when a second gateway node exists. The
   frame format is already routable, so nothing needs redesigning first.

---

## 5. Loose ends worth closing

- **A password is committed in `.github/workflows/ci.yml`** (`ADMIN_PASSWORD`). It is in
  every clone and every fork, and removing it from `HEAD` does not remove it from
  history. If that password is used anywhere real, rotate it now.
- **`AgentDevice.requireApproval` is unused.** Consent lives in the agent's own config on
  purpose — a setting an admin could flip is not consent. The column should either be
  dropped or given a clear meaning as an organisation-level floor.
- **`apps/web/tsconfig.tsbuildinfo` is tracked in git.** A build artifact that dirties
  the working tree on every type check; belongs in `.gitignore`.
- **Files do not use the loopback fast path**, only terminals. Transfers already stream
  with backpressure over the tunnel, so the latency win that justifies it for keystrokes
  is not the same win there.
