# Project Plan: Onshell.cloud Browser-Based SSH, SFTP, RDP Remote Access Platform

## 1. Project Goal

একটি secure browser-based remote access platform তৈরি করা হবে, যেখানে user/team একই dashboard থেকে SSH terminal, SFTP file manager, RDP session, saved hosts, credentials vault, snippets, audit logs এবং role-based access manage করতে পারবে।

এই project frontend/backend একই monorepo-এর ভিতরে থাকবে, কিন্তু production scalability-এর জন্য frontend, backend API, worker/gateway service, database, Redis এবং RDP gateway আলাদা service হিসেবে run করবে।

## 2. Project Name and Domain

* Project name: **Onshell.cloud**
* Primary domain: **onshell.cloud**
* Production URL: **https://onshell.cloud**
* Repository/root folder: **Onshell.cloud**

## 3. Core Features

### Authentication & User Management

* Email/password login
* Optional Google OAuth
* Two-Factor Authentication using TOTP
* Organization/team workspace
* Role-based access control:

  * Owner
  * Admin
  * DevOps
  * Developer
  * Read-only Auditor
* User invitation system
* Password reset flow
* Session management
* Device/session logout

### Host Management

* Add SSH/RDP/VNC host
* Host grouping
* Tags
* Environment label:

  * Production
  * Staging
  * Development
* Host health status
* Host ownership and team access
* Host notes/documentation

### SSH Terminal

* Browser-based terminal using WebSocket
* xterm.js frontend terminal
* Backend SSH bridge
* Password login support
* SSH private key login support
* SSH key passphrase support
* Host key verification
* Terminal resize support
* Copy/paste support
* Multiple terminal tabs
* Session timeout
* Session audit log

### SFTP File Manager

* Browse server files
* Upload file
* Download file
* Rename file/folder
* Delete file/folder
* Create folder
* File permission view
* Basic file editor for safe text files
* Upload size limit
* Permission-based file operations

### RDP Access

* Browser-based RDP through Apache Guacamole or guacd gateway
* RDP session launch from dashboard
* RDP credentials stored securely in encrypted vault
* Clipboard support where available
* Screen resize support
* Session close tracking
* Access permission per RDP host

### Snippets / Command Library

* Save reusable commands
* Personal snippets
* Team snippets
* Host-specific snippets
* One-click paste into terminal
* Variables support:

  * `{{host}}`
  * `{{username}}`
  * `{{project_path}}`

### Credential Vault

* Store passwords, SSH private keys, RDP passwords encrypted
* AES-256-GCM encryption
* Master encryption key from environment/KMS
* Never expose raw credentials to frontend after save
* Credential rotation support
* Per-user and per-team credentials

### Audit & Security Logs

* Login log
* Failed login log
* Host access log
* SSH session start/end
* RDP session start/end
* SFTP file operation logs
* Credential create/update/delete logs
* Admin action logs
* Searchable audit dashboard

### Admin Dashboard

* User management
* Team management
* Host management
* Active sessions
* Audit logs
* System health
* Storage usage
* Failed login attempts
* Security settings

## 4. Important Browser-Based Limitation

Browser-based SSH terminal, SFTP, and RDP are possible.

However, normal SSH local port forwarding like desktop Termius/terminal does is limited in browser because browsers cannot open arbitrary local TCP ports. For browser-based platform, port forwarding should be implemented as:

* Backend-side SSH tunnel
* Secure temporary web proxy URL
* Access-controlled internal service proxy
* Optional future desktop agent for true local forwarding

So first production version should include backend-side tunnel/proxy, not full desktop-style local port forwarding.

## 5. Recommended Tech Stack

### Monorepo

* Yarn workspace
* Turborepo or simple workspace structure
* TypeScript everywhere

### Frontend

* Next.js
* React
* TypeScript
* Tailwind CSS
* shadcn/ui or custom component library
* xterm.js for terminal
* React Query/TanStack Query
* Zustand or Redux Toolkit for local state

### Backend

* Node.js with NestJS or Fastify
* TypeScript
* WebSocket support for terminal streaming
* REST API for normal dashboard features
* Optional separate gateway worker for SSH/RDP sessions

### Database

* MySQL
* Prisma ORM
* Database migrations
* Seed scripts

### Cache / Queue

* Redis
* BullMQ for background jobs
* Session state
* Rate limiting

### RDP Gateway

* Apache Guacamole / guacd
* Docker-based deployment
* Backend should create secure temporary RDP session tokens
* Frontend should never receive raw RDP passwords

### Infrastructure

* Docker Compose for local development
* Production Dockerfiles
* Nginx/Caddy reverse proxy
* TLS/HTTPS
* GitHub Actions CI/CD
* Health checks
* Structured logging
* Backup strategy

## 6. Suggested Repository Structure

```txt
Onshell.cloud/
  apps/
    web/
      src/
      public/
      package.json
    api/
      src/
      prisma/
      package.json
    gateway/
      src/
      package.json

  packages/
    shared/
      src/
    ui/
      src/
    config/
      src/

  infra/
    docker/
    nginx/
    guacamole/
    scripts/

  docs/
    architecture.md
    deployment.md
    security.md
    api.md

  docker-compose.yml
  docker-compose.prod.yml
  package.json
  yarn.lock
  turbo.json
  .env.example
  README.md
```

## 7. Main Backend Modules

### Auth Module

* Register
* Login
* Logout
* Refresh token
* Password reset
* 2FA setup
* 2FA verify
* Current user endpoint

### Organization Module

* Create workspace
* Invite user
* Accept invitation
* Assign role
* Remove user

### Hosts Module

* Create host
* Update host
* Delete host
* List hosts
* Filter by type/tag/environment
* Assign host permissions

### Credentials Module

* Save encrypted password/key
* Update credential
* Delete credential
* Attach credential to host
* Decrypt only inside backend runtime when connecting

### SSH Module

* Open SSH session
* WebSocket terminal stream
* Resize terminal
* Close session
* Record session metadata
* Validate permissions

### SFTP Module

* List directory
* Upload
* Download
* Rename
* Delete
* Create folder
* Basic file edit

### RDP Module

* Create RDP session
* Generate secure session token
* Proxy/connect to guacd/Guacamole
* Close RDP session
* Record audit logs

### Snippets Module

* Create snippet
* Update snippet
* Delete snippet
* Share snippet with team
* Host-specific snippets

### Audit Module

* Create audit event
* Search audit logs
* Export audit logs
* Admin-only access

### Admin/System Module

* Health check
* Active sessions
* Failed login dashboard
* System metrics

## 8. Database Models

Minimum models:

```txt
User
Organization
OrganizationMember
Invitation
Role
Host
HostGroup
HostTag
Credential
SSHKey
Session
AuditLog
Snippet
SftpOperation
RdpConnection
TunnelRule
RefreshToken
TwoFactorSecret
PasswordResetToken
```

## 9. Security Requirements

* All passwords must be hashed using Argon2 or bcrypt
* Credentials must be encrypted before database save
* Raw private keys/passwords must never be returned to frontend
* Use short-lived access tokens
* Use refresh token rotation
* Add rate limiting on login and sensitive APIs
* Add account lock or cooldown after repeated failed login attempts
* Enforce HTTPS in production
* Add CSRF protection where cookie auth is used
* Validate all input using Zod or class-validator
* Sanitize file paths for SFTP operations
* Prevent path traversal attacks
* Use RBAC checks on every sensitive API
* Add audit logs for all admin/security/server actions
* Support host key verification for SSH
* Do not allow public anonymous server access
* Keep production secrets outside codebase

## 10. Development Phases

### Phase 1: Foundation

* Monorepo setup
* Next.js frontend
* Backend API
* MySQL + Prisma
* Auth system
* Organization/team system
* Basic dashboard layout

### Phase 2: SSH MVP

* Host CRUD
* Credential vault
* WebSocket SSH terminal
* xterm.js terminal UI
* Audit logs for SSH sessions

### Phase 3: SFTP

* SFTP file browser
* Upload/download
* Rename/delete/create folder
* Permission checks
* File operation audit logs

### Phase 4: RDP

* Guacamole/guacd Docker integration
* RDP host support
* RDP session launch
* Secure RDP token/session flow
* RDP audit logs

### Phase 5: Admin & Security

* RBAC polish
* 2FA
* Rate limits
* Audit dashboard
* Active session management
* Snippets
* Team permission system

### Phase 6: Production Deployment

* Docker production build
* Nginx/Caddy reverse proxy
* HTTPS
* CI/CD
* Backup script
* Monitoring
* Deployment documentation

## 11. MVP Delivery Target

First production MVP should include:

* Login/register
* Team workspace
* Add SSH host
* Add RDP host
* Save encrypted credentials
* Browser SSH terminal
* Browser SFTP file manager
* Browser RDP session
* Snippets
* Audit logs
* Admin dashboard
* Docker deployment
* README and deployment documentation

## 12. Production Quality Checklist

Before launch:

* All APIs protected
* RBAC tested
* Credentials encrypted
* No secret in logs
* No raw credential response to frontend
* Docker production works
* Database migration works
* Frontend build passes
* Backend tests pass
* SSH terminal stable
* RDP session stable
* SFTP upload/download tested
* HTTPS configured
* Backup/restore documented
* Audit logs working

## 13. Current Implementation Status - 2026-07-09

### Overall Progress

Code-side MVP implementation is about 90% complete. The main remaining work is remote-server activation, real database migration/seed execution, and live provider/host testing.

### Completed Coding Work

* Project name and public domain branding set to Onshell.cloud.
* Yarn workspace structure is ready for web, API, gateway, shared config, and UI packages.
* Public SaaS page includes package pricing, buyer details, and checkout API wiring.
* Admin panel can manage packages, SMTP settings, billing provider settings, users overview, and platform metrics.
* API includes auth, register/login, Google OAuth hooks, JWT cookies, refresh token handling, admin routes, package routes, checkout routes, SMTP routes, payment setting routes, and audit logging.
* Two-factor authentication support is implemented with TOTP/Google Authenticator style setup and verification.
* Prisma schema, migration files, and seed script are prepared, including the platform admin account.
* Gateway code includes SSH/SFTP integration and RDP gateway bridge structure.
* README/deployment documentation, CI workflow, and MySQL backup script are included.

### Local Blocker

Database migration and seed were not run locally because MySQL authentication is not available in this workstation environment. A local MySQL service was detected on port 3307, but the available credentials failed password authentication. Because of that, database activation is intentionally left for the remote server.

### Remote Server Steps

Run these after MySQL credentials are ready on the remote server:

```bash
corepack enable
yarn install --immutable
yarn db:generate
yarn db:deploy
yarn db:seed
yarn build
```

Required remote environment values:

* `DATABASE_URL`
* `JWT_SECRET`
* `COOKIE_SECRET`
* `MASTER_ENCRYPTION_KEY`
* `PUBLIC_BASE_URL`
* `GOOGLE_CLIENT_ID`
* `GOOGLE_CLIENT_SECRET`
* SMTP host, port, username, password, from email, and from name
* Payment provider public key, secret key, webhook secret, and mode
* Gateway URL, guacd host/port, and production reverse proxy settings

### Remaining Work

* Run database migration and seed on the remote server.
* Verify seeded admin login with `latifur.tech@gmial.com` and the configured seed password.
* Test real Google login after OAuth redirect URLs are configured for `https://onshell.cloud`.
* Test Google Authenticator/TOTP setup and recovery flow with a real account.
* Test SMTP save and test email with real SMTP credentials.
* Test Stripe/Paddle/SSLCommerz/manual checkout with real provider credentials.
* Test SSH terminal, SFTP operations, and RDP sessions against real remote hosts.
* Configure HTTPS, reverse proxy, production process manager, logs, backups, and monitoring.
