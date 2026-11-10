# Docker environments

Use Docker Engine with Compose **2.20 or later**. Run commands in the specified
directory; Compose includes the existing deployment definitions and resolves build
and bind paths from the repository root. Node, Java and pnpm are not required on
the host. The one-time setup helper uses Bash and OpenSSL. Allocate at least 2 GB to Keycloak alone; measure capacity alongside
SPHERE's existing services before sizing the shared machine.

| Environment | Directory | State | Public gateway / inbox |
| --- | --- | --- | --- |
| Development | `docker/development` | Existing `.lab`, lab database/avatar volumes | localhost:18000 / localhost:18025 |
| Staging | `docker/staging` | `.identity-staging-runtime`, separate staging volumes | Private gateway localhost:18011 |
| Production | `docker/production` | `.identity-runtime`, existing production volumes | Private gateway localhost:18010 |

Staging uses real HTTPS, Brevo and a GitHub App, with a distinct hostname,
catalogue branch, database, credentials and gateway alias. Point it at a staging
SPHERE network/gateway, not the live production login. The example hostname must
be replaced. Never share a runtime directory or database between environments.

## Development: one command

```bash
cd docker/development
docker compose up -d --build --wait --wait-timeout 300
```

Plain `docker compose up` also builds missing images and starts dependencies.
`--build` additionally rebuilds changed source. Preparation, import, bootstrap and
catalogue synchronization are dependencies, not manual steps. The existing
`./lab up`, `./lab check`, `./lab logs` and `./lab down` commands remain supported
and use the same project, state and volumes. Do not run both entry points at once.

- Account: <http://localhost:18000/identity/account/>
- Administration: <http://localhost:18000/identity/admin/>
- Mailpit: <http://localhost:18025>

Use `admin-score@example.invalid`, `support@example.invalid` or
`person@example.invalid`. Codes arrive in Mailpit; administrators still need a
passkey. Optional lab settings are in `docker/development/.env.example`.
Existing `.lab/external-sso.json` is retained, including private Google settings.

## GHCR publication after a verified push to main

`ci.yml` calls `publish-images.yml` only after its complete verification job passes
for a push to `main`. Pull requests and `develop` do not publish. The reusable
workflow builds the exact verified commit for `linux/amd64` and `linux/arm64`,
uses the automatic `GITHUB_TOKEN` with `contents: read` / `packages: write`, and
pins its GitHub/Docker actions to verified commit SHAs. No production credentials
or SSH access are needed by the publishing workflow.

| Image | Purpose |
| --- | --- |
| `ghcr.io/scorelabus/scoretech-identity-provider` | Custom Keycloak, themes and Java providers |
| `ghcr.io/scorelabus/scoretech-identity-account` | Account API with its own default command |
| `ghcr.io/scorelabus/scoretech-identity-admin` | Admin API with its own default command |
| `ghcr.io/scorelabus/scoretech-identity-gateway` | Account/Admin web applications and production Nginx |
| `ghcr.io/scorelabus/scoretech-identity-tooling` | Render, realm setup, catalogue seeding and synchronization |

Account and Admin web assets continue using the shared gateway; this preserves the
existing single-origin architecture. All five images receive `main` and
`sha-<full 40-character commit SHA>` tags. Publication is serialized; verified
commits superseded by a newer main revision are skipped. Wait for **all five**
publish jobs to pass before deploying a release. A partial publish is not a
complete release; rerun failed jobs for that main revision while it remains HEAD.

In GitHub, allow GitHub Actions to publish repository packages under the
organization's policies. The workflow requests the required token permissions.
After the first publication, choose public visibility for each package if anonymous
pulls are wanted. Public source code does not automatically make GHCR packages
public. Otherwise log in on the server using a GitHub account and personal access token (classic) with
`read:packages` and access to these packages:

```bash
docker login ghcr.io --username YOUR_GITHUB_USER
```

Paste the read token only at the password prompt. The runtime GitHub App used for
catalogue editing is a separate credential; it is not replaced by `GITHUB_TOKEN`.
If a package already existed outside this workflow, connect it to this repository
and grant its Actions workflows access before publishing.

The server stays on the `main` branch with `IDENTITY_VERSION=main`. After each
successful image publication, GitHub Releases gets an incremental changelog and
links to the exact source/image revision. Release versions start at the package
version (currently `v0.1.0`) and increase the patch automatically; raising the
package version above the latest release selects that new base version. Retrying
a completed source revision reuses its release instead of creating another one.
No detached checkout or routine `.env` version edit is required.

Wait until the latest main commit has a completed release, then update from the
repository root:

```bash
git switch main
git pull --ff-only origin main
docker compose -f docker/production/compose.yaml pull
docker compose -f docker/production/compose.yaml up -d --no-build --wait --wait-timeout 300
```

A failed/partial image publication never creates a GitHub release. Full SHA tags
remain available for incident diagnosis and deliberate rollback; normal deployment
uses the main tag. `IDENTITY_IMAGE_PREFIX` changes the registry/namespace if needed.

Production/staging Compose contains no source builds. Gateway configuration is
inside the published gateway image. Initializers use the published tooling image.
The development lab retains its source builds and private local state.

## Production: configure once, then Compose

First merge the reviewed Identity release into `main` and wait for CI, all five
GHCR jobs and the GitHub release to finish. On the server, clone the `main` branch
and keep that branch checked out.
The SPHERE integration must also be present in the deployed SPHERE release
([PR #205](https://github.com/SCORELabUS/SPHERE/pull/205), targeting `develop`).
Do not switch production to an unmerged/unreleased frontend or gateway.

From the Identity repository root:

```bash
./docker/setup production
```

This creates `docker/production/.env` with five distinct, random internal
credentials and owner-only permissions. It never overwrites an existing `.env`
or rotates existing credentials. Edit that file and replace every placeholder:

- `IDENTITY_VERSION=main`; keep the server repository on `main`.
- Public origin and matching WebAuthn RP ID (initially `sphere.score.us.es`).
- First operator email, Brevo SMTP login/key and authenticated sender.
- GitHub App ID, installation ID and catalogue repository/branch. Grant the App
  repository contents read/write access. The repository must have `main`.
- Published terms/privacy URLs, versions and SHA-256 digests of those versions.
- Existing SPHERE Docker network name. With SPHERE's current production Compose
  directory/project it is `production_sphere-network`; check `docker network ls`
  if a custom project name is used.

Install the App's PEM key at `docker/production/secrets/github-app.pem`, or change
`IDENTITY_GITHUB_KEY_FILE`. Paths in `.env` are repository-relative; absolute paths
also work. On Linux the key must be readable by container UID 1000, with mode 0600
and a private parent directory; use `sudo chown 1000:1000` as appropriate. Never
make it world-readable. Compose mounts each secret only in its consumers. The
remaining credentials are read from `.env` and mounted as `/run/secrets/*`, not
passed to the API containers as plaintext environment variables.

If upgrading an existing deployment that used separate secret files, copy the
**existing** values into the corresponding `.env` keys instead of using newly
generated values. Changing a database/client secret in `.env` does not rotate the
stored database/client credential. Keep existing database/avatar volumes and
`.identity-runtime` intact.

Optional external SSO configuration:

```bash
mkdir -p .identity-runtime
cp config/external-sso.example.json .identity-runtime/external-sso.json
chmod 600 .identity-runtime/external-sso.json
```

Do not overwrite an existing file. Configure the approved Google client/secret;
the US example already uses its existing approved callback. These files and
`.env` are ignored by Git and excluded from image build contexts. Keep backups
private; do not paste `docker compose config` output into logs or tickets.

SPHERE must already be running so its shared Docker network exists. Then:

```bash
cd docker/production
docker compose pull
docker compose up -d --no-build --wait --wait-timeout 300
```

Plain `docker compose up -d` also pulls the selected release and starts the full
triplet. An explicit `pull` first checks that every image is available before
changing running services. No compilation tools are required on the server.
Startup renders configuration, initializes a missing realm, reconciles managed
settings, initializes a missing GitHub catalogue, waits for verified application,
and then starts both APIs and the gateway. Existing users, credentials and
catalogue revisions are preserved. Initial catalogue seeding writes to GitHub
only when the selected environment does not yet exist.

Only Identity's gateway joins SPHERE's network, as `scoretech-identity-gateway`.
PostgreSQL, Keycloak, API ports and native administration stay private. The
loopback port is for host diagnostics; SPHERE Nginx reaches port 8080 over Docker.
SPHERE owns public ports 80/443 and the TLS certificate.

For staging, use `./docker/setup staging`, edit `docker/staging/.env`, and run the
same Compose command from `docker/staging`. Configure its SPHERE gateway upstream
as `scoretech-identity-staging-gateway:8080` on the chosen shared network.

## SPHERE gateway and activation

The matching SPHERE changes are in `nginx/production` and
`docker/production/docker-compose.yml`. In SPHERE's **existing**
`docker/production/.env`, merge these settings:

```dotenv
AUTH_PROVIDER=scoretech
SCORETECH_IDENTITY_UPSTREAM=scoretech-identity-gateway:8080
FRONTEND_URL=https://sphere.score.us.es
SCORETECH_IDENTITY_ISSUER=https://sphere.score.us.es/identity/auth/realms/score
SCORETECH_IDENTITY_CLIENT_ID=<SPHERE application Client ID>
SCORETECH_IDENTITY_CLIENT_SECRET=<SPHERE application secret>
SCORETECH_IDENTITY_TRANSPORT_URL=http://scoretech-identity-gateway:8080/identity/auth/realms/score
SCORETECH_IDENTITY_ACCOUNT_URL=https://sphere.score.us.es/identity/account/
```

Create SPHERE's confidential application in Identity first, with exact callback
`https://sphere.score.us.es/api/v1/auth/identity/callback` and appropriate
permissions. To reach Identity while preparing that application, keep `AUTH_PROVIDER=local`,
set `SCORETECH_IDENTITY_PREVIEW=true` in SPHERE’s deployment `.env`, and rebuild/
start its Nginx (`docker compose up -d --build nginx` from SPHERE’s production
directory). Preview forwards `/identity` without taking over SPHERE’s login or
its legacy US callback. Use email/passkeys or Google to prepare the first operator;
US login in Identity needs the final callback handover. Disable preview after
switching to `AUTH_PROVIDER=scoretech`. Do not enable the final mode until account
linking/migration and provider configuration are ready. This
deployment does **not** bulk-migrate existing SPHERE users.

Then, from SPHERE's `docker/production`:

```bash
docker compose up -d --build server client nginx
```

`AUTH_PROVIDER` is shared by the API and Nginx. Changing it and running Compose
recreates both with consistent settings. Invalid modes/upstreams fail startup.
Local mode remains the default and works with Identity completely stopped.
Enabled mode resolves Identity via Docker DNS, including after container
replacement, and routes:

| Public URL/path | Handler |
| --- | --- |
| `/identity`, `/identity/` | Redirect to Account |
| `/identity/account/` | Account Web |
| `/identity/admin/` | Admin Web |
| `/identity/auth/realms/score/…` | Public native authentication |
| `/identity/api/account/…`, `/identity/api/admin/…` | Corresponding API |
| `/api/v1/users/auth/sso/us/callback` | Identity; redirects into native US broker cookie path |
| `/api/v1/auth/identity/callback` | **SPHERE API**, completes SPHERE's OIDC flow |

Google redirect URI:
`https://sphere.score.us.es/identity/auth/realms/score/broker/google/endpoint`.
US keeps `https://sphere.score.us.es/api/v1/users/auth/sso/us/callback`.
Do not proxy SPHERE's own OIDC callback to Keycloak or internally rewrite the US
callback: the latter needs a browser redirect to receive the realm cookie.

For a hostname change, update both origins/RP ID, SPHERE settings, public DNS/TLS
and registered Google/application callbacks. Existing passkeys and external US
service approval require explicit migration review; changing `.env` cannot move
credentials bound to the old RP/issuer.

## Release updates and backups

Before the first cutover, back up the existing SPHERE MongoDB, Redis/session state,
static uploads and configuration using its normal operational procedure. Confirm
that SPHERE still works in local mode. Identity can run in preview while existing
users link their accounts; bulk migration is not implemented by this deployment.

For an Identity update, first back up its PostgreSQL, private runtime/configuration
and avatar volume using `docs/OPERATIONS.md`. Record the current source SHA and
latest release, then pull the released main branch. Keep `IDENTITY_VERSION=main`;
routine updates do not require a checkout to a SHA or a tag edit. Keep all credentials, project names and persistent
volumes intact. From `docker/production`:

```bash
docker compose pull
docker compose up -d --no-build --wait --wait-timeout 300
docker compose ps
```

Verify the public issuer, email delivery, passkey login, both portals and catalogue
publication before completing the change. For a deliberate rollback to a previous application
release, use a reviewed revert on main or the recorded source/image pair. If a provider upgrade
changed the database schema, image rollback alone is insufficient: follow the
validated backup/restore procedure. Never use `down -v` for deployment or rollback.

## Operations and rollback

```bash
docker compose ps
docker compose logs --tail=100 render realm-setup catalogue-seed config-sync
docker compose down
```

`down` retains data. Never use `down -v` or delete runtime state for an update.
Back up PostgreSQL, avatar volumes, runtime/configuration and private credentials
as described in `docs/OPERATIONS.md`. Internal client credentials and public web
configuration must be kept consistent across updates.

To roll SPHERE back, set `AUTH_PROVIDER=local` in its deployment `.env` and run
`docker compose up -d server nginx`; original local users/data remain. Identity
routes and the US callback return to their original handlers. Users created only
in Identity need a local method if they must use SPHERE after rollback.

Verify the public discovery issuer, OTP delivery, passkeys, both external
providers, Account/Admin SSO, permission enforcement, session renewal and
backup/restore on the target HTTPS host before opening production traffic. Local
tests do not certify live Brevo, GitHub installation access or approved US login.

Deployment regression checks (Node 24/pnpm on the development host):

```bash
pnpm test:deployment
pnpm test:deployment:first-boot
```

The first-boot test needs the lab images built by `./lab up`; it creates a unique
Docker project and empty runtime, checks real HTTP boundaries and repeat startup,
then removes only its own disposable data. It never mounts the existing `.lab`
or uses the existing database/avatar volumes.
