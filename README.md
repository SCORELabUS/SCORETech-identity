# SCORETech Identity

The product brand is **SCORETech Identity**. Always preserve the capitalization
`SCORETech` in user-facing text, logos and email templates.

Centralized identity and SSO for the SCORE ecosystem, built on Keycloak with the
passwordless identity extensions extracted from TenTuPlaza. The realm is `score`;
login, Account, Admin and transactional emails use English and SCORE branding.

The implemented triplet includes email-code registration/sign-in, passkeys and
TOTP, personal profile/preferences/session settings, user administration,
invitations, assisted recovery, security events, an editable role catalogue,
permission declarations, managed OpenID Connect applications and application
access rules. Applications generate their own client IDs, show backend secrets
at creation/rotation or through an explicit administrator reveal in connection details, and combine callback settings with required permissions. The sidebar avatar opens
profile and sign-out actions; Security groups credentials by sign-in method, and
Preferences includes light/dark previews. Account also supports a shared profile
(display name, bio, city/country and optional date of birth), social profile links,
and SPHERE's avatar picker with initials, artwork, colors and cropped photo uploads.
Photos persist in the private `identity-avatars` volume in both Compose deployments.
The Danger zone offers native, freshly authenticated identity deletion with typed
confirmation and protected administrative accounts; service data remains managed
in the respective services. Run `pnpm test:e2e:profile` against the local lab to
exercise these flows with an isolated, disposable identity.
Administrators, including delegated support operators, must enroll and use a
passkey. Public registration does not grant access to protected services.

## Run the local laboratory

Install Docker with Compose v2, start Docker, and run from this repository:

```bash
./lab up
```

This builds and starts PostgreSQL, the customized Keycloak provider, Account API,
Admin API, the two web applications, the gateway, Mailpit and the local catalogue
fixture/synchronizer. No host Node.js, Java, Maven, external SMTP account or GitHub
credentials are needed to launch the lab. The first build downloads dependencies
and container images; allow it to finish before opening the applications.

| Application    | Local URL                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| Account        | [localhost:18000/identity/account/](http://localhost:18000/identity/account/)                               |
| Admin          | [localhost:18000/identity/admin/](http://localhost:18000/identity/admin/)                                   |
| Captured email | [localhost:18025](http://localhost:18025)                                                                   |
| OIDC discovery | [score realm discovery](http://localhost:18000/identity/auth/realms/score/.well-known/openid-configuration) |

Use `localhost` consistently, including for passkey registration. The gateway and
Mailpit bind to loopback. Ports 18000 and 18025 must be available.

| Seeded identity               | Intended use                                                    |
| ----------------------------- | --------------------------------------------------------------- |
| `admin-score@example.invalid` | Full identity, role, permission and access-rule administration  |
| `support@example.invalid`     | Delegated, read-only identity support; still requires a passkey |
| `person@example.invalid`      | Personal Account settings without Admin access                  |

These identities have no passwords. Enter an email address, retrieve its code
from Mailpit, then complete any passkey enrollment required by the login flow.
Use a real browser/device passkey or security key for manual administrative tests.
New public users can also register with a fictitious email address and read their
code in Mailpit.

```bash
./lab check             # Configuration, Linux coordination and HTTP boundary checks
./lab status            # Container state
./lab logs              # Recent service logs
./lab logs admin-api    # Recent logs for one service
./lab down              # Stop the lab without deleting its data
```

PostgreSQL uses a named volume; generated local configuration and catalogue state
live in `.lab/`. Restarting the lab preserves identities, credentials and catalogue
history. There is no automatic volume purge or reset in these commands. The local
GitHub-compatible fixture exercises versioned role, permission and access-rule publication and real provider
synchronization without contacting a GitHub account; it is excluded from the
production tooling image.

## Develop and verify

Use Node.js 24 and pnpm 10.9.0, matching the container build:

```bash
corepack enable
corepack prepare pnpm@10.9.0 --activate
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs workspace builds, type checks, lint, package and tooling tests. The
provider Docker build also runs the Java provider tests; running those directly
requires Java 21 and Maven (`pnpm provider:test`).

With the local lab running, browser verification is available through:

```bash
pnpm test:e2e
```

The default browser executable is Google Chrome on macOS. To use Playwright's
Chromium instead:

```bash
pnpm exec playwright install chromium
IDENTITY_E2E_CHROMIUM=1 pnpm test:e2e
```

The E2E harness only accepts the isolated HTTP `localhost` lab. It uses virtual
WebAuthn devices, creates its own test identities, publishes a test role, and
removes its named test accounts afterward. Screenshots/results are written to
`test-results/triplet/`. Virtual authenticators do not replace a manual passkey
check on a real device. [Verification record](docs/VERIFICATION.md) describes the
completed local checks and their limits. CI repeats the lab and browser workflow.

## External sign-in

Google and Universidad de Sevilla CAS are supported through Keycloak identity
brokering. Configure `.lab/external-sso.json` using
`config/external-sso.example.json`, then run `./lab up`. Google needs its client
secret and an authorized Keycloak callback; the US keeps SPHERE's approved public
callback through the gateway. See [setup and local testing](docs/OPERATIONS.md#google-and-universidad-de-sevilla-sign-in)
for the exact callback URLs and deployment requirements. A missing configuration
leaves external providers disabled. Run `pnpm test:e2e:sso` against the lab for the
isolated CAS fixture flow; it does not contact the US or Google.

## Deploy and integrate

Docker entry points are available in `docker/development`, `docker/staging` and
`docker/production`. Development starts with `docker compose up -d --build`;
production/staging first need their private `.env`, GitHub App key and existing
SPHERE network configured. See [Docker deployment](docker/README.md) for exact
commands, gateway activation, callbacks, state preservation and rollback.

The initial production origin is `https://sphere.score.us.es`, served under
`/identity` by SPHERE's HTTPS gateway. Hosting and broker settings remain
configurable; changing WebAuthn RP/issuer requires a migration review.

## Repository and provenance

- `provider/`: Keycloak distribution, Java extensions and SCORE login/email themes.
- `apps/`: Account and Admin web/API applications.
- `packages/identity-internal/`: shared server-side identity adapters.
- `tooling/`, `config/`, `deploy/`: rendering, catalogue synchronization and containers.
- [Third-party notices](THIRD_PARTY_NOTICES.md) and [license](LICENSE): upstream
  attribution and retained licenses.

Native identity contracts, Java package names and technical identifiers such as
`tentu-*`, `tentu.*` and the protected `administrador` role are deliberately retained
where they form the provider/API compatibility contract. They do not select the
realm or contact Tentu services. The private Tentu React identity SDK is not included.
