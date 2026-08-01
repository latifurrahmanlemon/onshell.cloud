# API Notes

The API currently exposes development route contracts backed by in-memory data. The route shapes are ready for persistence with Prisma.

## Public SaaS

* `GET /plans`
* `POST /checkout`

`/plans` returns active packages that the public page can sell. `/checkout` currently returns a mock checkout URL and should be connected to Stripe, Paddle, SSLCommerz, or manual invoicing.

## Auth

* `POST /auth/register`
* `POST /auth/login`
* `GET /auth/me`
* `POST /auth/logout`
* `POST /auth/2fa/setup`
* `POST /auth/2fa/verify`
* `POST /auth/2fa/complete`
* `POST /auth/2fa/disable`
* `GET /auth/2fa/status`
* `GET /auth/google/start`
* `GET /auth/google`
* `GET /auth/google/callback`

Successful login returns tokens and also sets `access_token` and `refresh_token` HTTP-only cookies for browser clients.

Production requirements:

* Hash passwords with Argon2id or bcrypt.
* Sign short-lived access tokens.
* Rotate refresh tokens.
* Enforce TOTP when enabled.
* Configure Google OAuth with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`.
* Audit successful and failed login attempts.

## Hosts

* `GET /hosts`
* `POST /hosts`
* `PATCH /hosts/:hostId`

Filters:

* `type`: `ssh`, `rdp`, `vnc`, or `agent`
* `environment`: `production`, `staging`, or `development`
* `search`: host name, address, or tag query

Hosts with `isAgent` are created by a machine enrolling itself and cannot be added or
imported by hand — see Agents below.

## Agents

Machines running the Onshell Agent. Full design in [agent.md](agent.md).

* `POST /agents/pairing-codes`
* `POST /agents/enroll`
* `POST /agents/token`
* `GET /agents`
* `POST /agents/:deviceId/revoke`
* `DELETE /agents/:deviceId`

`/agents/enroll` and `/agents/token` carry no user session: the caller is a program on a
customer's own machine, and the credential is the request body — a pairing code, or the
device token issued in exchange for one. Both are rate-limited.

`GET /agents` merges stored devices with live connection state from the gateway, so
`online` reflects this moment rather than a column that would go stale the moment a
laptop lid closed.

Agent hosts accept `ssh` and `sftp` sessions, gated per device by `allowShell` and
`allowFiles`; `rdp` is refused. `POST /sessions` also takes an optional `shell` for agent
hosts, naming one of the tokens that machine advertised.

## Credentials

* `GET /credentials`
* `POST /credentials`

Credential responses intentionally return metadata only. Raw passwords and private keys must never be returned after save.

## Sessions

* `GET /sessions`
* `POST /sessions`
* `POST /sessions/:sessionId/close`

Supported `protocol` values:

* `ssh`
* `sftp`
* `rdp`
* `vnc`
* `tunnel`

## Audit

* `GET /audit`

Audit rows should be written for auth, host, credential, SSH, SFTP, RDP, tunnel, snippet, and admin actions.

## Admin

* `GET /admin/overview`
* `GET /admin/users`
* `GET /admin/plans`
* `POST /admin/plans`
* `PATCH /admin/plans/:planId`
* `GET /admin/subscriptions`
* `GET /admin/smtp`
* `PATCH /admin/smtp`
* `GET /admin/settings`
* `PATCH /admin/settings`
* `GET /admin/payment-settings`
* `PATCH /admin/payment-settings`

Admin routes require a platform-admin user. The seed creates the first platform admin.

## Gateway

Gateway now has real SSH/SFTP/RDP protocol adapters:

* SSH sessions use `ssh2` and stream shell data through `/ws/ssh/:sessionId`.
* SFTP sessions use `ssh2` and expose `GET /sessions/:sessionId/sftp/list`.
* RDP sessions open a guacd TCP tunnel and proxy Guacamole protocol data through `/ws/rdp/:sessionId`.
