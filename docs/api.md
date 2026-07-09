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

* `type`: `ssh`, `rdp`, or `vnc`
* `environment`: `production`, `staging`, or `development`
* `search`: host name, address, or tag query

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
