# Security Policy

Onshell.cloud brokers privileged access to other people's servers. A bug here is
not a broken page; it is somebody's production box. Reports are welcome and taken
seriously, including ones that turn out to be wrong.

## Reporting a vulnerability

Email **security@onshell.cloud**. If you want the reply encrypted, say so and a
key will be sent in the first response.

Please do **not** open a public GitHub issue for a vulnerability, and please do not
test against `onshell.cloud` itself — run the stack locally (see the README) and
attack that. Testing against the hosted service touches other people's sessions.

Include what you have: the affected component (`apps/api`, `apps/gateway`,
`apps/desktop`, `apps/agent`, `apps/web`), a commit hash, reproduction steps, and
what an attacker gets out of it. A rough report you are unsure about is better
than a polished one you never send.

### What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement that a human read it | 3 business days |
| Initial assessment and severity | 10 business days |
| Fix or a dated plan for one | 90 days |

We will tell you when a fix ships, credit you in the release notes unless you would
rather stay anonymous, and let you publish once the fix is out. There is no paid
bounty programme today; that is stated plainly rather than implied.

## Scope

In scope — this repository and anything it deploys:

* authentication, 2FA, refresh-token rotation, session fixation
* RBAC and host-access grants (one workspace reaching another's hosts)
* the credential vault: encryption, decryption boundaries, leakage into logs,
  responses, or audit metadata
* the credential **lease** path used by the desktop app's direct connections
* the gateway: session-id guessability, cross-session access, SFTP path traversal
* the agent tunnel: device-token handling, pairing, consent and revocation
* the desktop app: preload/IPC boundary, token storage, update channel integrity
* injection, SSRF, and RCE anywhere in the stack

Out of scope:

* findings that require an already-compromised machine, or physical access
* missing hardening headers with no demonstrated impact
* rate-limiting complaints without a working amplification
* automated-scanner output pasted without a reproduction
* social engineering of staff or users
* denial of service by volume

## Known and deliberate trust boundaries

Please read these before reporting them as bugs. Each is a design decision, and each
is a reasonable thing to argue with — argue with the design, not as a 0-day.

1. **The server can decrypt saved credentials.** Credentials are sealed with
   AES-256-GCM under `MASTER_ENCRYPTION_KEY`, which the API holds. This is what makes
   browser-based SSH possible at all: something has to open the connection, and the
   browser cannot. An operator with the database *and* the key can read the vault.
   Self-host if that is not acceptable to you.
2. **The gateway trusts its callers.** It has no notion of users or organisations;
   it does what it is told. Access control lives in the API, and the gateway is meant
   to sit on a private network behind `GATEWAY_SHARED_SECRET`. A deployment that
   exposes the gateway publicly without that secret is misconfigured, and the README
   says so.
3. **An installed agent can serve that machine's shell.** That is its purpose. It is
   bounded by explicit pairing, a visible tray presence, per-device `allowShell` and
   `allowFiles` policy, a local audit journal the machine's owner can read, and
   revocation from the console.
4. **The desktop app's direct mode leases credential material to the user's own
   machine.** A lease is short-lived, single-host, audited, and only issued to a
   device enrolled by the account that already has access to that host. It hands the
   user material for a host they are entitled to open anyway. Report anything that
   widens that: leases for hosts you lack access to, leases outliving their host
   grant, material reaching disk unencrypted, or a lease usable from another device.

## Supported versions

`master` is what receives fixes. There is no long-term-support branch yet. Deployments
should track releases; the release notes call out anything security-relevant.
