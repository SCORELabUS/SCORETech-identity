# Docker environments

Use Docker Engine with Compose **2.20 or later**. Run commands in the specified
directory; Compose includes the existing deployment definitions and resolves build
and bind paths from the repository root. Node, Java and pnpm are not required on
the host. Allocate at least 2 GB to Keycloak alone; measure capacity alongside
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

## Production: configure once, then Compose

From the repository root:

```bash
./docker/setup production
```

This creates `docker/production/.env` with five distinct, random internal
credentials and owner-only permissions. It never overwrites an existing `.env`
or rotates existing credentials. Edit that file and replace every placeholder:

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
docker compose up -d --build --wait --wait-timeout 300
```

After initial image builds, plain `docker compose up -d` starts the full triplet.
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
