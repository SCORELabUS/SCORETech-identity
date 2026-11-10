# SCORETech Identity agent guide

## Scope and product contracts

This repository implements centralized identity for the SCORE ecosystem using
Keycloak, Account Web/API and Admin Web/API. Start with `README.md`; use
`docs/OPERATIONS.md` for integration/maintenance and `docker/README.md` for
environment setup, deployment and its verification limits.

- The user-facing brand is **SCORETech Identity**, with this exact capitalization.
- All user-facing screens and transactional emails use English.
- The default realm is `score`; the default public path is `/identity`.
- Public registration verifies email and grants personal Account access, not
  automatic access to protected applications.
- Preserve passwordless email codes, passkeys and TOTP. Administrative access
  requires a passkey; do not bypass this requirement to simplify testing.
- The protected administrator role has technical ID `administrador` and display
  name **Admin**. Administrators retain access to all permissions, including newly
  declared permissions. Keep delegated operators bounded by their own authority.
- Existing `tentu-*` identifiers and Java packages can be compatibility contracts.
  Do not mechanically rename them or replace them with branding changes.
- SPHERE/SPACE user migration and live production deployment are separate work;
  do not treat local lab success as proof of either.

## Repository map

- `provider/`: customized Keycloak distribution, Java extensions under
  `providers/email-otp/`, and SCORE login/email themes under `themes/score/`.
- `apps/account-api/`, `apps/admin-api/`: TypeScript HTTP APIs, OpenAPI documents,
  authorization declarations and package tests.
- `apps/account-web/`, `apps/admin-web/`: React 19 + Vite applications.
- `packages/identity-internal/`: shared server-side identity and provider adapters.
- `packages/ui/`: shared UI, authentication/session handling and styles.
- `config/realm-template.json`: source realm configuration.
- `tooling/`: configuration rendering, realm bootstrap, catalogue fixture and sync.
- `docker/development/`, `docker/staging/`, `docker/production/`: canonical Compose entry points; see `docker/README.md`.
- `deploy/local/`, `deploy/production/`: shared Compose and gateway definitions included by those entry points.
- `tests/unit/`: tooling/configuration/coordination tests.
- `tests/e2e/`: real laboratory browser and OAuth flows.
- `THIRD_PARTY_NOTICES.md` and retained licenses document upstream provenance. Preserve attribution when adapting extracted code.

## Commands and verification

Use **pnpm 10.9.0**, not npm or yarn, and Node.js 24 (see `.nvmrc`).

```bash
pnpm install --frozen-lockfile
pnpm check                  # Build, types, lint, package tests and tooling tests
pnpm --filter @scoretech/admin-web build
pnpm test:tooling
pnpm provider:test          # Requires Java 21 and Maven on the host
```

The provider image build also runs the Java suite. Some coordination tests require
Linux and are exercised by the lab checks. Run focused checks appropriate to the
change; use `pnpm check` for broad implementation changes and before publishing a
complete release. For UI changes, verify the actual rendered behavior, keyboard
interaction, and relevant responsive/dark states. Do not add tests that merely
mirror static markup for trivial presentation changes.

```bash
./lab up                    # One-command build, initialization and startup
./lab check                 # Linux configuration/coordination and HTTP checks
./lab status
./lab logs [service]
./lab down                  # Preserves database and local state
pnpm test:e2e               # Requires the running isolated lab
```

The lab needs Docker with Compose v2; host Node/Java or external credentials are
not needed for `./lab up`. Account is at
`http://localhost:18000/identity/account/`, Admin at
`http://localhost:18000/identity/admin/`, and Mailpit at
`http://localhost:18025`. Use `localhost` consistently for WebAuthn RP matching.
`IDENTITY_LAB_PORT` can override the gateway port; keep it consistent across runs.

Seed accounts are `admin-score@example.invalid` (full Admin),
`support@example.invalid` (delegated read-only support), and
`person@example.invalid` (Account only). Codes go to Mailpit; administrative users
still enroll/use passkeys. Do not promote similarly named accounts by accident.

E2E defaults to Chrome on macOS. For Playwright Chromium:

```bash
pnpm exec playwright install chromium
IDENTITY_E2E_CHROMIUM=1 pnpm test:e2e
```

Browser tests mutate real lab identities/catalogue/application state and write
artifacts to `test-results/triplet/`. Do not run overlapping stateful E2E flows or
point them at production. Virtual WebAuthn is not a real-device passkey check.

## Authorization, applications and sessions

- Role/permission definitions use a versioned catalogue. Admin publishes through
  the GitHub adapter (a local fixture in the lab); synchronization applies the
  native provider registry. Distinguish saved revisions from verified application.
- Keep live server/provider authorization checks. Hiding UI controls is not an
  authorization boundary; token refresh must not bypass role or application checks.
- Managed OpenID Connect applications own callback/origin settings and required
  permissions. Preserve exact redirect validation, PKCE, public/confidential
  client distinctions and affected-session invalidation on sensitive changes.
- Client secrets must stay out of list responses, logs, screenshots and persisted
  browser artifacts. Preserve explicit protected reveal/rotation and no-store
  responses. Never store raw access/refresh tokens in committed fixtures.
- Preserve protected built-in roles, dependency checks before role/permission
  deletion, invitation redemption locking, and audit reasons/history.
- Successful access-token renewal must preserve the active session and page.
  Shared renewal is coordinated in `packages/ui/src/session.ts`; avoid introducing
  independent refresh races or logging users out on transient refresh failures.
- Keep the shared authorization lock and its inode across configuration updates.
  Production currently supports one Admin API process; do not scale it without
  replacing process-local administrative coordination appropriately.

## UI conventions

Reuse `packages/ui` components and tokens. Styling uses Tailwind CSS v4 together
with shared CSS and app-specific styles; do not introduce a second design system.
Preserve light/dark variants, visible focus indicators and pointer cursors for
interactive controls. Login/email themes are provider assets, not React pages;
increment the theme cache version when changing cached login assets.

Admin lists use tables with an Actions column, search/refresh controls and 25-row
pagination. Keep search over the complete applicable dataset, not just the current
page. Align header actions with the title/description block; let search expand.
Place dialog confirmation buttons on the right, primary farthest right and Cancel
to its left. Dialog backdrops dismiss safely without treating interior clicks or
drags as outside clicks. Destructive actions require confirmation. The role revision
history is a native disclosure, closed by default. The avatar menu retains My
profile and red Sign out; Account shows Administration only for the live Admin role.

## Secrets, deployment and state preservation

Never commit `.lab/`, `.identity-runtime/`, `.identity-staging-runtime/`, `secrets/`, `.env` files with credentials, database
volumes, generated builds, browser artifacts, private keys or generated secrets.
Only sanitized example env files belong in Git. Do not delete volumes or reset
the existing lab as a routine verification step.

Production configuration initially targets `https://sphere.score.us.es/identity`.
Keep the origin configurable through the renderer and documented environment
variables; changing hosts also needs issuer/client configuration and WebAuthn
migration review. Production SMTP uses Brevo via Compose secrets sourced from the private deployment `.env`; the local
lab uses Mailpit. Follow the setup order and secret ownership rules in
`docs/OPERATIONS.md`. Keep native administration private and do not expose database
or provider ports as a shortcut. Report actual verification separately from
unperformed live Brevo, GitHub installation, production or migration checks.

## External identity providers

Google uses Keycloak's native broker; US login uses the `score-us-cas` SPI in the
existing provider JAR. `tooling/external-sso.mjs` renders and reconciles the owned
broker configuration and flow aliases. Private config is
`.lab/external-sso.json` locally or `.identity-runtime/external-sso.json` in
production; copy the sanitized `config/external-sso.example.json` when needed.
Never print Google secrets. Google stays disabled until its secret is configured.

Keep first-broker account creation/linking alternatives inside a REQUIRED subflow;
Keycloak ignores alternatives alongside REQUIRED executions. Post-broker policy
must preserve local email verification, legal consent, safe registration roles and native
administrative passkeys. Do not trust US email or silently merge accounts by mail.
The legacy SPHERE CAS callback must redirect into the native realm cookie path;
internal proxy rewriting alone loses the path-scoped authentication cookie.
`pnpm test:e2e:sso` uses a local CAS fixture and temporarily replaces only the lab's
US broker configuration, restoring it afterwards. Do not run it alongside other
stateful E2E flows. Actual US login needs the approved public callback routed to
Identity; actual Google login needs a valid secret and registered callback URI.

Successful external sign-in skips redundant VERIFY_EMAIL through the user-bound
server auth note and BrokerAwareVerifyEmail, including pending actions left by old
broker versions. Never disable realm-wide email verification or falsely mark CAS
mailboxes verified. Explicit verification and existing-account linking remain native.

Account's Connected identities view lives under `#security/identities` and uses
native `idp_link:<alias>` / `score-unlink-identity:<alias>` actions. The metadata
API forwards only the user's bearer to private `score-identities`; never expose
federated tokens. Realm reconciliation defines native account role prerequisites
but grants/scopes only `manage-account-links`. Keep the native Account REST path
blocked at the gateway so it cannot bypass last-method checks. Fallback methods
must satisfy the entire local email policy, not just have a stored credential.

Browser initialization probes same-origin SSO via `auth/silent-callback` before
showing sign-in. Preserve focus/visibility/pageshow expiry checks, single-flight
renewal and same-subject recovery after a rejected local refresh. Native session
expiry/revocation and required factors remain authoritative; do not extend access
token lifetimes to hide renewal bugs. `pnpm test:e2e:session` verifies these flows.

Shared profile data lives in `scoreProfile` / `scoreSocialLinks`; only these
allowlisted groups may be patched and they are not automatically public or token
claims. Avatar editing reuses SPHERE's artwork/crop workflow. Compose photo storage
is the private persistent `identity-avatars` volume, with server-side image decoding
and normalization. Preserve named-color/legacy-avatar compatibility. Native
`score-delete-account` requires fresh authentication, exact email confirmation,
Account Web client binding and protected-admin checks; never expose an unrestricted
self-delete API or claim that deleting the identity erases service-owned data.
