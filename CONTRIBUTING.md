# Contributing to Onshell.cloud

The repository is public so that anyone handing this software their server
credentials can check what it does with them. Contributions are welcome on the
same terms: changes that are easy to read and easy to verify.

## Getting the stack running

```bash
corepack enable
yarn install
cp .env.example .env
docker compose up -d mysql redis guacd
yarn db:generate && yarn db:migrate && yarn db:seed
yarn dev
```

`yarn db:seed` prints a generated admin password once outside production. The
README has the full setup, including the ports each service listens on.

Before opening a pull request:

```bash
yarn typecheck
yarn lint
yarn test
```

## Repository layout

| Path | What lives there |
| --- | --- |
| `apps/web` | Next.js marketing site, customer console, admin panel |
| `apps/api` | Fastify API — auth, RBAC, hosts, credential vault, billing, audit |
| `apps/gateway` | SSH/SFTP/RDP sessions, agent tunnel termination |
| `apps/desktop` | Electron desktop client — local terminal, direct SSH, agent mode |
| `apps/agent` | headless CLI agent for servers and unattended machines |
| `packages/agent-protocol` | wire protocol between agent and gateway |
| `packages/api-client` | HTTP client shared by the web console and the desktop app |
| `packages/shared` | shared types, RBAC and plan helpers |
| `packages/config` | environment loading and production secret guards |

## What a good change looks like

**Small and single-purpose.** One reviewable idea per pull request. A refactor
bundled with a behaviour change hides the behaviour change.

**Explained where it is surprising.** Comments here carry their weight: they say
*why* a thing is the way it is, not what the next line does. `apps/api/src/lib/session-cookie.ts`
and `apps/gateway/src/routes.ts` are the house style — read one before you write.

**Written like the code around it.** Match the local naming, comment density, and
idiom rather than importing a style from elsewhere. Formatting is `yarn format`
(Prettier); do not reformat files you did not otherwise touch.

**Tested where a test can fail.** Pure logic — token handling, cookie attributes,
import parsers, plan limits — gets a Vitest case next to it (`*.test.ts`). UI and
protocol plumbing are reviewed by hand; do not write a mock so elaborate that it
only tests itself.

**Migrations are additive.** A migration that drops or rewrites a column needs a
note in the PR describing the rollout. `yarn check:migrations` guards naming.

## Changes that touch security

Anything below gets a slower, more suspicious review. That is not distrust of you;
it is the point of the project.

* the credential vault — encryption, decryption boundaries, or anything that moves
  secret material closer to a client
* the credential **lease** path for desktop direct connections
* authentication, 2FA, refresh-token rotation, session cookies
* RBAC and host-access grants
* the agent's pairing, consent, or revocation logic
* the desktop preload/IPC boundary, or anything that widens what the renderer can call
* the update channel for shipped binaries

Say in the PR description what a malicious caller could now do that they could not
before, and why that is bounded. If the answer is "nothing", say that and say how
you know.

Do not open a public issue or PR for a vulnerability in released code — see
[SECURITY.md](SECURITY.md).

## Licence of contributions

This project is licensed under the **GNU Affero General Public License v3.0**
([LICENSE](LICENSE)). By submitting a pull request you agree that your contribution
is licensed under the AGPL-3.0 as well. There is no CLA and no copyright
assignment: contributors keep their copyright, and nobody — including the
maintainers — can relicense the project out from under them.

If you are contributing on behalf of an employer, make sure you are allowed to.

## Reporting bugs and asking for features

Open a GitHub issue. For a bug, include the version or commit, the component, what
you expected, what happened, and the smallest way to reproduce it. For a feature,
describe the problem before the solution — the interesting part is what you were
trying to do.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
