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
* `GET /auth/organizations`
* `POST /auth/organizations/:organizationId/switch`
* `GET /auth/google/start`
* `GET /auth/google`
* `GET /auth/google/callback`

Successful login returns tokens and also sets `access_token` and `refresh_token` HTTP-only cookies for browser clients.

### Workspaces, for accounts that belong to more than one

An account can hold memberships in several organizations — accepting an invitation with an
address that already has an account is the ordinary way it happens. One of them is *active*
for the session, and everything else the API returns is scoped to it.

`GET /auth/organizations` lists them: `{ activeOrganizationId, organizations: [{ id, name,
slug, role, isActive, joinedAt }] }`. `role` is the role held in *that* workspace, which is
not usually the same in all of them.

`POST /auth/organizations/:organizationId/switch` re-issues the session against that
workspace and returns `{ user, organization, changed, accessToken?, refreshToken? }`.
Switching to the workspace already active is a no-op: `changed: false`, and no session is
minted. Everything the client had loaded belongs to the previous workspace and must be
discarded — including open terminals, which stay connected to machines the new workspace has
no claim on.

The membership is resolved from the authenticated user id and the path. Nothing in the body
is read, and the role always comes from the target membership — a role in a request would be
a client asking to be an owner. A workspace the caller is not a member of returns **404**,
identical to one that does not exist, so the endpoint is not an oracle for organization ids.

The stored workspace is a preference, never an authorization: every request re-reads the
memberships and re-derives the role, so removing a member takes effect on their next request
rather than at token expiry. When the workspace a live token names is no longer one of the
caller's, `GET /auth/me` and `POST /auth/refresh` fall back to one that is and say so, in
`activeOrganizationChanged: { reason: "membership_revoked", previousOrganizationId,
previousOrganizationName, organizationId, organizationName }`. Nothing leaks either way — the
fallback is a workspace they really belong to — but the console needs to be able to tell the
user "you were removed from X, you are now in Y" rather than silently showing a different
workspace's hosts.

`GET /auth/me` returns `organizations` alongside `user` and `organization`, so a client can
decide whether to offer a switcher on its first call.

Session length: the access token lives 12 hours; the refresh cookie lives `SESSION_TTL_DAYS`
(default 30) and slides — `POST /auth/refresh` rotates it and restarts the clock, so a browser
that visits inside the window stays signed in without re-entering a password. A rotated token is
still accepted for 60 seconds afterwards, so several console tabs refreshing at once do not sign
each other out. Sign-out, a password change, and admin or owner revocation expire the token
outright, which that grace window cannot revive.

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

## Desktop

The native app. Full design in [desktop.md](desktop.md).

Signing in from the browser, because a native window cannot render Google's redirect or
a Turnstile widget:

* `POST /desktop/auth/requests`
* `POST /desktop/auth/requests/:requestId/poll`
* `GET /desktop/auth/requests/:requestId/preview`
* `POST /desktop/auth/requests/:requestId/approve`
* `POST /desktop/auth/requests/:requestId/deny`

Create and poll carry no user session — the caller is an app that does not have one yet,
which is the whole point. Poll authenticates with the `x-onshell-device-secret` returned
once at creation, and the poll that finds an approval returns the token pair and
consumes the request; a second poll gets `expired`. Preview, approve, and deny are the
browser's half and need a signed-in session; approve additionally requires the user code
displayed in the app window, which is deliberately not carried in the URL. Requests live
five minutes in memory, with a five-attempt cap on the code.

Enrolment and credential leases for direct connections:

* `POST /desktop/devices`
* `GET /desktop/devices`
* `POST /desktop/devices/:deviceId/revoke`
* `POST /desktop/leases`
* `POST /desktop/sessions/:sessionId/state`

A lease is not a new authorisation: it is issued only for a host the caller could
already open a relayed session on, it names one host and one session, and it expires in
60 seconds.

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
