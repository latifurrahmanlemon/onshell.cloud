# Security Requirements

Onshell.cloud handles privileged server access, so security must be treated as a product feature.

## Credentials

* Hash user passwords with Argon2id or bcrypt.
* Encrypt saved credentials with AES-256-GCM before database save.
* Store encryption keys outside the codebase.
* Never return raw private keys or passwords to the frontend after save.
* Decrypt credentials only inside trusted backend or gateway runtime memory.
* Add rotation metadata and audit entries for every credential change.

## Sessions

* Use short-lived session tokens for SSH, SFTP, RDP, and tunnel launches.
* Bind gateway sessions to user, organization, host, and protocol.
* Expire idle sessions.
* Record start, close, failure, and timeout events.
* Validate SSH host keys.

## API

* Validate every request body and query.
* Apply RBAC checks on every sensitive route.
* Rate-limit login, token refresh, credential, and session launch endpoints.
* Add account cooldown after repeated failed logins.
* Use CSRF protection if cookie auth is enabled.
* Keep secrets out of logs.

## SFTP

* Normalize and constrain all paths.
* Prevent path traversal.
* Audit upload, download, edit, rename, delete, and permission operations.
* Restrict text editing by file size and content type.

## RDP

* Do not expose raw RDP passwords to the browser.
* Use temporary gateway tokens.
* Restrict clipboard and file transfer based on host policy.
* Isolate guacd network access from public internet.

