# SCORETech Identity operations and integration

This guide describes the checked-in implementation and commands. The production
Compose configuration is prepared; it is not a record of a deployed instance or
successful delivery through live Brevo SMTP. Keep deployment verification and its
evidence separate from configuration preparation.

## Local laboratory

From the repository root, with Docker and Compose v2 running:

```bash
./lab up
```

The launcher builds the provider and application images, renders isolated local
configuration, starts the services and waits for their startup checks. It does not
read production credentials. Images/dependencies need network access on their
first build. Use a current Docker installation with sufficient memory for the
provider; its default container memory limit is 2 GiB, in addition to the database
and other services.

The default addresses are Account at `http://localhost:18000/identity/account/`,
Admin at `http://localhost:18000/identity/admin/`, and Mailpit at
`http://localhost:18025`. `IDENTITY_LAB_PORT=18001 ./lab up` selects another gateway
host port; keep using that same value for subsequent lab commands. The Mailpit
port remains 18025. Always use `localhost`: an authenticator registered for that
RP ID is not interchangeable with one registered for `127.0.0.1`.

The seeded `admin-score@example.invalid`, `support@example.invalid` and
`person@example.invalid` accounts have no passwords. Mailpit captures their email
codes. The first two have administrative access and must enroll/use a passkey;
`support` has read-only operations. A public registration can use Account without
receiving Admin or other protected-service access.

Account's **Preferences** page saves light/dark mode and shows a website preview.
Security starts with method cards and counts; open Passkeys, Authenticator app or
Email codes to manage that method. The avatar/name menu uses one caret and a red Sign out action. Account includes
its personal-profile link and shows Administration only when its live profile has
the protected Admin role. Admin also includes My profile in its user dropdown,
without a separate Account link in the sidebar. Roles and Permissions
use tables with action columns; permission details are read-only. Roles and
Invitations include the directory's search, refresh and Previous/Next controls,
with 25 rows per page. Permissions and Applications use the same 25-row pagination,
with filtering across the complete list, search resetting to the first page and
page bounds adjusted after deletion. The shared footer displays the copyright
symbol, the browser's current year and SCORETech Identity. Role search covers identifiers and descriptions across the
complete catalogue. Invitation search covers names and role identifiers on the
server before pagination, so results are not limited to the visible page. Invitations
also use a table, showing status, role grants, registration usage, expiry and edit/
revoke/delete actions. Revocation requires confirmation. Deletion has a separate
confirmation and is available only for revoked or expired invitations; the native
store rechecks this condition under its redemption lock. Existing accounts, role
grants and registration audit records are preserved. The shared Account/Admin
shell has no top header; mobile navigation remains accessible from the page heading. All shared
modals close on a click on their backdrop, while clicks inside and drags starting
inside leave them open. In Admin, the directory's gear column opens a member's
management details. The Permissions and Applications pages are separate from
role assignment; their editing capabilities are reported by the server.

Use `./lab check`, `./lab status`, `./lab logs [service]` and `./lab down` for smoke
checks, status, diagnostics and shutdown. `down` preserves the named PostgreSQL
volume and `.lab/` files. Those contain local identities, passkeys, catalogue
revisions and local-only credentials; they are ignored by Git. Do not delete
volumes as an ordinary stop/restart procedure.

The catalogue fixture implements the GitHub protocol used by Admin and config-sync
inside the Compose network. It is not a public endpoint or production backend.
The gateway refreshes Docker DNS for recreated services. Realm setup, catalogue
synchronization and administrative mutations share the same kernel lock file;
preserve that file and its inode across rendering/restarts.
Saving roles in the lab creates versioned catalogue changes; the synchronizer
applies the real provider registry and reports the observed revision.

## Production prerequisites and secrets

Read [.env.production.example](../.env.production.example) and
[production Compose](../deploy/production/compose.yaml) before preparing a host.
The initial public origin is `https://sphere.score.us.es`, with the triplet under
`/identity` and realm `score`. The production gateway only listens on host loopback
port 18010 by default; an existing HTTPS reverse proxy must route the public
prefix to it. PostgreSQL and the provider have no published host ports.

Prepare a separate environment and runtime directory; never reuse `.lab/` as
production state. Pin the source release being built. Fill the public values in
`.env.production`, including the first operator email, WebAuthn RP ID, GitHub App
installation, authenticated sender and published terms/privacy URLs, versions and
SHA-256 document digests. Rendering validates the references' shape; it does not
fetch or certify those documents. The local legal fixture is not a production
terms/privacy publication.

Set `IDENTITY_SECRETS_DIR` to a private absolute directory containing these files:

| File                 | Contents / consumer                                       |
| -------------------- | --------------------------------------------------------- |
| `database-password`  | PostgreSQL password, also read by Keycloak                |
| `bootstrap-password` | Initial native Keycloak operations administrator password |
| `admin-client`       | Secret for `identity-admin-service`                       |
| `account-client`     | Different secret for `identity-account-service`           |
| `sync-client`        | Different secret for `identity-config-sync`               |
| `github-app.pem`     | GitHub App private key in PEM format                      |
| `brevo-smtp-login`   | Brevo SMTP login                                          |
| `brevo-smtp-key`     | Brevo SMTP key                                            |

Use distinct service-client credentials. Store single-line credentials without
embedded newlines; the PEM private key retains its normal multiline format. The
Compose file mounts each secret separately. Never put secret values in the env
file, catalogue, image, shell arguments or Git.

The APIs and Keycloak run as UID 1000. On a Linux deployment, arrange the mounted
secret files to be readable by that UID, with owner-only mode `0600` and a private
host directory (`0700`). For example, after provisioning the files through your
secret manager, an operator can set ownership and permissions for the chosen
private directory:

```bash
secret_dir=/absolute/private/score-identity-secrets
sudo chown 1000:1000 "$secret_dir" "$secret_dir"/*
sudo chmod 0700 "$secret_dir"
sudo chmod 0600 "$secret_dir"/*
```

Use the same absolute path for `IDENTITY_SECRETS_DIR` in `.env.production`. Check
container readability if the host's secret mechanism changes ownership/mount
semantics; making the key world-readable is not the remedy. Rendered private files
in `.identity-runtime/` are also credentials-bearing: preserve their restricted
ownership/modes. Only runtime web configuration is public.

The native Keycloak bootstrap administrator is separate from an identity operator
in the `score` realm. The generated first SCORE operator starts with unverified
email, proves ownership by email OTP, and enrolls a passkey in the normal login
flow. Custody of native bootstrap access is an operations responsibility; do not
seed a shared password into SCORE users or expose the native console publicly.

## First production setup order

These are manual deployment instructions, not commands already executed by the
implementation work. From the repository root:

```bash
cp .env.production.example .env.production
# Provision the secret files and fill every placeholder in .env.production.
```

Use this helper so paths, build contexts and the env file resolve from the root:

```bash
production() {
  docker compose --project-directory "$PWD" \
    --env-file .env.production \
    -f deploy/production/compose.yaml "$@"
}
```

Then build, render, initialize the remote catalogue, and start, in that order:

```bash
production --profile setup build render keycloak account-api gateway
production --profile setup run --rm --no-deps render
production --profile setup run --rm --no-deps catalogue-seed
production up -d --wait --wait-timeout 300
production ps
```

`render` creates `.identity-runtime/import/score-realm.json`, the initial catalogue
seed and public web configuration. It reads private secret files but does not
contact Keycloak, Brevo, GitHub or the document URLs. It refuses known local fixture
credentials/runtime state.

`catalogue-seed` is the first external write: it uses the configured GitHub App to
create the selected catalogue branch from the repository's trusted `main` branch
when missing, and publishes the initial environment catalogue when missing. The
repository and `main` must exist and the installation must have access. An existing
environment catalogue is left intact; this is not an overwrite/reset command.

Startup then initializes PostgreSQL/Keycloak, runs `realm-setup`, starts the
catalogue synchronizer, and waits for the applied catalogue before starting the
APIs and gateway. `realm-setup` reconciles managed profile policy, callback URLs,
SMTP and document references; it preserves user records/credentials. Keycloak's
startup realm import initializes a missing realm, rather than updating an existing
realm on every restart. Changing a secret file alone does not rotate an existing
client's stored credential: coordinate credential rotation explicitly.

After startup, verify the public issuer, OTP delivery to the first operator,
passkey enrollment, Account/Admin SSO, role publishing/application, recovery and
private-route boundaries through the actual HTTPS proxy. Verify backup/restore
before accepting the deployment as operational. A container marked healthy is not
proof of SMTP deliverability or of the external proxy configuration.

## HTTPS reverse proxy and public URLs

Keep the `/identity` prefix intact when forwarding to the production gateway. An
outer Nginx on the same host can use this shape in its existing HTTPS server:

```nginx
location = /identity {
    return 302 /identity/account/;
}
location /identity/ {
    proxy_pass http://127.0.0.1:18010;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto https;
}
```

Adapt upstream addressing to the real topology: a proxy running inside another
container cannot reach the host gateway through its own `127.0.0.1`. Use an explicit
shared network/service address or the host-routing mechanism appropriate to that
installation. Keep the gateway/provider unavailable to untrusted direct callers,
and overwrite forwarded headers at the trusted edge. Preserve the gateway's
route restrictions and security headers. Do not move SPHERE's existing root OAuth
or OIDC discovery routes as part of this deployment.

The canonical issuer is:

```text
https://sphere.score.us.es/identity/auth/realms/score
```

Discovery appends `/.well-known/openid-configuration`. The custom Admin application
is `/identity/admin/`; native Keycloak `/admin` and `master` routes are not exposed
through the gateway. Account API is `/identity/api/account/v1/account`; Admin API
is `/identity/api/admin/v1`.

To change the public host, update `IDENTITY_PUBLIC_ORIGIN` and the reviewed RP ID,
rerender configuration, reconcile the realm and restart the affected services.
Preserve the same database/realm when preserving subject IDs. OIDC consumers must
adopt the new exact issuer/callback/logout/origin configuration and users may need
to sign in again. A redirect from the old host does not make an old issuer valid
at the new host.

Passkeys are bound to their WebAuthn RP ID. Changing from the current hostname to
an unrelated RP ID is not transparent. An explicitly chosen compatible parent
RP domain may support a planned move among its trusted subdomains, but that choice
must precede enrollment and requires verification of the new origins and clients.
Otherwise plan credential reenrollment and tested recovery before retiring the
old host. Never broaden RP scope or accepted issuers just to make a move work.

The checked-in gateway and optimized provider use `/identity` and
`/identity/auth`. The public origin is runtime configuration; a different base
path needs coordinated gateway/frontend/provider build changes and verification.
Do not treat an arbitrary base-path environment change as a completed deployment.

## Catalogue publishing and authority

Install a real GitHub App on the one configured SCORE catalogue repository, with
repository `Contents: write` and the installation/private-key settings from the
env/secret files. The adapter requests an installation token limited to that
repository and permission. Ensure repository policy allows the intended direct
catalogue commits. Do not grant unrelated repository/workflow administration.
GitHub's contents permission is repository-scoped; the application's path/branch
restrictions are additional checks, not a GitHub per-path permission.

Admin edits role definitions and assigns roles to users through separate
operations. A live protected identity administrator can also declare new atomic
permissions, such as `sphere:admin`, and manage application access rules. This
authority is reported by `GET /catalogue` as the server-derived
`capabilities.managePermissions` and `capabilities.manageAccessRules`; the browser
does not decide who is protected. Mutation authorization still checks the
operation permission and the actor's signed and live authority. The protected role is displayed as **Admin**; its internal identifier remains
`administrador` so existing assignments and provider guards remain intact. It
inherits the entire validated atomic permission catalogue on every publication.
A live protected Admin can define, assign and invite roles using newly declared
permissions without waiting for an older token to contain those new atoms. Signed
and live service-entry/operation authority, current sessions, passkeys and graph
validation still apply. Delegated role
editors remain limited to permissions they currently hold and that are present
in their signed token.

Roles and permissions expose Delete in their table action columns, with a
confirmation dialog and an audit reason. Admin and the member registration
baseline cannot be deleted. A role referenced by another role or a group must
have those references removed first. Deleting a role retires its definition and
clears its grants; native IDs and memberships are retained for revision recovery.
Member accounts are never deleted by catalogue operations.

Only a live protected Admin can delete a service permission. References in ordinary
roles, application requirements (including disabled applications), legacy access
rules or service-owned token scopes must be removed first. The API verifies live
managed applications before publication; native reconciliation repeats this
check before any mutation. Internal permissions in reserved namespaces remain
protected. Permission names, service ownership and descriptions remain read-only;
new atoms must use an application namespace. The reserved domains are `identity`, `admin-web`, `account`,
`account-console`, `admin-cli`, `broker`, `keycloak`, `realm-admin`,
`realm-management`, `security-admin-console` and `system`; prefixes `identity-*`
and `default-roles-*` are also reserved. The server derives the protected
`administrador` role from the complete permission catalogue. Do not customize that
role's references manually. Public-registration defaults remain unprivileged and
cannot grant protected-service access.

Every publication includes a reason of at least eight characters and its base
revision for conflict detection. The UI distinguishes a saved desired revision
from verified application: it polls application status for up to 60 seconds and
requires both `state: applied` and an `observedRevision` matching the published
revision for this environment. It renews the operator's session after verification
so newly active administrator permissions become available. A failed or timed-out
application remains a saved desired change; review its status and correct it
instead of treating the save as successful enforcement.

Config-sync polls the configured branch, verifies the snapshot digest and
reconciles the provider authorization registry. It releases the active projection
only after verifying the observed revision. APIs consume the applied catalogue,
not an unverified pending Git HEAD. Keep the runtime catalogue directory persistent
and do not edit generated JSON by hand. A failed publication/application requires
investigation/retry; it must not be reported as success.

The sync client also performs deployment realm reconciliation and carries powerful
realm/client-management capability. Keep its secret with deployment tooling,
separate from Admin API, Account API and browser credentials. It is not a normal
read-only integration key. Administrative mutations use an in-process queue and a
shared kernel `flock` with config-sync. The lock covers the full operation even
after a browser disconnects; it is released when its owning process dies. Native
application and verified projection publication happen within the same lock.
Failed/incomplete application blocks account mutations until verification recovers;
catalogue repair remains available. Keep the coordination file mount shared and
writable by the legitimate participants; do not replace its inode while running.

The supported deployment uses **one Admin API process/replica**. Before distributing
replicas across hosts, implement and verify coordination on the chosen shared
infrastructure. Separate host-local files do not coordinate independent machines.

## Application access rules and token permissions

A catalogue may contain optional `accessRules`. Each rule has a stable `id`, an
existing `clientId`, one canonical `origin` and a nonempty `requiredPermissions`
list. Every listed permission is required; these are known atomic permissions,
not role names. Rule IDs and client IDs must be unique. Omitting `accessRules`
while editing preserves the previous desired rules; an explicit empty array
removes them.

Use one dedicated OIDC authorization-code client per origin and admission policy.
The client must already be registered, enabled and configured without service
accounts. Machine-to-machine clients, native Keycloak internal clients and
`identity-*` clients are outside this editor. Every registered callback must be an
absolute exact URL on the rule's single origin. Multiple callback paths on that
origin are allowed; wildcard callbacks are not. The origin contains no path,
trailing slash, credentials, query, fragment, wildcard or domain-prefix match.
HTTPS is required; the provider permits HTTP loopback only in the local
environment. The Admin contract accepts local `localhost` or `127.0.0.1` origins.

For example, a client registered for both `https://service.example/auth/callback`
and `https://service.example/secondary/callback` can have origin
`https://service.example`. A policy cannot express “allow all of this website
except `/admin`.” Protect `/admin` in the application's routes or a proxy that
checks the required permission. If a separate OIDC admission policy is needed,
use a separately registered client and rule. Adding a rule neither registers a
client nor installs protection on an arbitrary URL.

These SCORE provider checks require all rule permissions from the current live
user grants during initial authentication, including an existing cookie SSO
session, and during token issue and refresh. A rule-managed client's access token
is restricted to its required atomic permission scope and includes that client's
own audience. The Admin browser's token scope expands to the verified active
atom catalogue. Existing service-owned token scopes are preserved; a rule cannot
claim a client scope that belongs to an existing service contract. Removing a
rule leaves its formerly managed client token scope restricted and empty instead
of reverting to full scope. Application-side permission checks therefore remain
essential after policy changes and removal.

Permissions are atomic Keycloak realm roles. The role catalogue combines them as
composite realm roles; assignments, users and credentials live in Keycloak's
PostgreSQL database. Git holds the versioned desired catalogue, not user accounts.
The verified projection identifies the active configuration. Signed access tokens
carry the allowlisted roles/atoms in `realm_access.roles` for their client scope;
services validate the signature, issuer, audience and expiry before interpreting
those claims. An already issued access token may remain valid until its TTL
expires when validated offline. The local Admin API additionally rechecks the
live enabled actor, session and effective permissions, intersected with signed
rights, for administrative requests. Other applications must choose and implement
the live checks their operations require.

The default lab includes `lab-service-web`, with origin
`http://localhost:18000` and callback
`http://localhost:18000/identity/lab-service/callback`. This is a local OIDC protocol
test client, not a SPHERE integration. It does not migrate SPHERE or SPACE users.
When using a different configured lab port, use the corresponding rendered origin
and callback.

The [Keycloak Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/index.html)
explains realms, composite roles, clients and token scope mappings. The
[Authorization Services Guide](https://www.keycloak.org/docs/latest/authorization_services/index.html)
describes resource/policy enforcement concepts. The catalogue access rules above
are this repository's custom provider implementation; they are not a claim that
Keycloak's native Authorization Services automatically protect these URLs or
that this project has configured a UMA resource server.

## Brevo transactional email

Production rendering configures Keycloak's native SMTP connection to
`smtp-relay.brevo.com:465` with TLS, using `brevo-smtp-login` and
`brevo-smtp-key`. Set the authenticated sender email and the public sender name
(`SCORETech Identity` by default). These are SCORETech Identity templates in English,
not SPHERE password-reset templates.

SPHERE's TypeScript email service uses Brevo's REST SDK/API key. **That API key is
not an SMTP password.** Provision the SMTP credential from Brevo's SMTP settings;
see [Brevo SMTP credentials and transport](https://developers.brevo.com/docs/smtp-integration).
Check sender/domain configuration, host egress and actual delivery. Keep action
links intact and review click tracking for one-use recovery/invitation links.
Local Mailpit capture does not validate any of those production settings. Never
log OTPs, recovery URLs, authorization codes, tokens or SMTP secrets as diagnostics.

## Add a future OIDC application

Applications uses a table of names/client IDs, origins, required-permission counts
and status. Its **Actions** column opens connection details, editing and secret
rotation in modals. Connection values are available from each application's setup
dialog, including a Rotate secret action for backend applications. Confirmation
actions are right aligned throughout Account, Admin and native account-action
screens, with cancellation to the left of the primary action.

Use **Admin → Applications → Create application**. A current protected identity
administrator with catalogue management access and a passkey-authenticated session
can create, edit, disable/reactivate applications and rotate backend secrets.

1. Declare the application's atomic permissions in **Permissions**, and wait for
   their catalogue revision to be applied.
2. Create an application with a name, type, one exact origin, between one and ten
   exact redirect URLs, optional exact post-logout URLs, and the required
   permissions. Every selected permission is required. Identity/internal
   administrative permissions cannot be selected for external applications.
3. Choose **Browser application** for an SPA: its public client uses Authorization
   Code and PKCE S256 without a client secret. Choose **Backend application** for
   a server that can retain a secret: its confidential client authenticates token
   requests with its secret and also uses PKCE S256. Password, implicit and
   machine-to-machine grants are disabled for these interactive applications.
4. Copy the generated stable `score-app-…` client ID. For backend applications,
   copy the secret from the creation dialog. Connection details starts with a
   Credentials section: **Show secret** explicitly retrieves the current value
   without rotating it, **Copy** copies it and **Hide secret** clears it from the
   view. Closing the modal also clears the revealed value. Normal list/setup
   metadata never includes secrets. An explicit reveal requires the current
   protected administrator, a passkey-authenticated session and the current app
   version; its response is not cached. **Rotate secret** replaces the value
   immediately and invalidates its previous value without a grace period.
5. Use **Setup details** for the issuer, discovery document and registered URLs.
   Configure your application's OIDC library with these values. Keep backend
   secrets on that server; never put them in browser code or source control.
6. Group the selected service permissions into roles and assign those roles to
   users. Registering a client or selecting a permission does not grant it to any
   user or create that user's business account inside the connected service.

Creation, policy, token scope and configuration are committed together in
Keycloak's native database transaction. App settings, generated IDs and secrets
persist in Keycloak's PostgreSQL database and are covered by its database backup;
secrets are never placed in the versioned permission/role catalogue. Editing and
rotation require the current application version so stale forms cannot overwrite
newer changes. The client ID remains stable. The type selector is editable: switching to a backend
client generates a fresh secret shown once; switching to a browser client removes
its secret and rotation/grace metadata. A type change ends the online and offline
SSO sessions that used that client, including other application connections sharing
those particular sessions, and invalidates their unspent authorization codes. The
administrator may need to sign in again. A newly generated secret remains in its
one-time dialog until it is closed, before the list is refreshed. Ordinary edits
and explicit secret rotation do not end sessions. Disable
an application to stop sign-in and refresh while retaining its configuration;
public/dynamic client registration is not offered. **Delete application** in the
Actions column opens a confirmation modal naming the client. Cancel or clicking
outside makes no deletion request; confirmation permanently removes that OIDC
client and its credentials with a current-version check. Its client sessions and
pending authorization sessions are cleaned up through Keycloak; users, catalogue
roles and unrelated SSO connections are retained. Existing offline-validated access
tokens can remain valid until expiry. System clients and clients created outside Applications cannot be
changed through this page.

Access checks use the application's current required permissions during both SSO
and token issuance/refresh. Tokens expose only the selected atomic service
permissions and the application's own audience. Disabling or changing a policy
does not invalidate an already issued token validated offline before its expiry.
The application must still enforce its own routes, operations and resources.

The former **Access rules** page is removed; old `#access-rules` links redirect to
**Applications**. Existing versioned legacy policies are retained by the backend
for compatibility and are covered by API/protocol regression tests. They cannot
override Applications-managed clients. System clients remain outside this editor.
Do not expose the native administration API or the internal `score-applications`
provider resource through a public proxy.

The triplet's callback examples are `/identity/account/auth/callback` and
`/identity/admin/auth/callback`; connected applications register their own exact
URLs. HTTPS is required outside the local loopback laboratory. Read protocol
endpoints from the issuer's discovery document. See the official
[Keycloak OpenID Connect guide](https://www.keycloak.org/securing-apps/oidc-layers).

A resource API accepts access tokens, not ID tokens. Validate the signature using
that issuer's JWKS, allowed algorithm, expiry, exact `iss`, own `aud`, `sub`, and
session/client constraints required by its policy. Check the service entry
permission, operation permission and ownership/tenant rules server-side. A role
or OAuth scope is not a resource ACL and does not authorize arbitrary organization
or object access. Already issued offline-validated tokens may retain their rights
until expiry; account for refresh/revocation semantics and perform live checks
where the operation requires them.

SPHERE and SPACE user linking/migration are deliberately deferred. Their current
identity providers, local IDs and OAuth/MCP grants are not rewritten by this
triplet. A future migration must map `(issuer, sub)` safely and preserve resource
ownership; do not merge identities automatically by matching email.

## Backup, restore and upgrades

Back up the entire Keycloak PostgreSQL database, including provider extension
tables. Keep encrypted copies outside the host together with the matching source/
image versions, relevant catalogue revision, private runtime inputs and separate
secret-manager recovery. A realm export or Git role history alone is insufficient.
Runtime archives contain secrets and must not be committed or uploaded as public
artifacts.

An operator can take a logical database backup while the database is running. This
example uses the `production` helper above and an explicitly chosen private path:

```bash
umask 077
backup_file=/absolute/private/backups/score-identity.dump
production exec -T database pg_dump -U keycloak -d keycloak -Fc > "$backup_file"
```

Test restoration in an isolated, separately named recovery stack first. A restore
replaces the target database contents; select the intended backup and target
explicitly. For an authorized restore of this stack, stop writers before running
`pg_restore`, and keep sync stopped until its desired Git catalogue state has been
reviewed against the restore point:

```bash
production stop gateway account-api admin-api config-sync realm-setup keycloak
production up -d database
production exec -T database pg_restore -U keycloak -d keycloak \
  --clean --if-exists --exit-on-error --single-transaction < "$backup_file"
# Verify the restored database, compatible image versions and desired catalogue.
production up -d --wait --wait-timeout 300
```

These commands are manual recovery examples and are not run by `./lab` or by this
guide. Resuming sync may reapply a newer desired catalogue from Git. Confirm that
this is intended before restarting it. Do not delete production volumes to carry
out a routine restart, update or restore.

Before upgrading Keycloak or the SPI, test their combined image against a backup
restoration and the triplet browser flows. Keep schema compatibility and the
supported upgrade path explicit. Rolling back an image tag does not automatically
reverse database migrations. Restoring an older role definition is a new reviewed
catalogue revision, rather than silently rewinding its generation.

## References

- [README](../README.md): local launch and development commands.
- [Original implementation plan](PLAN_IMPLEMENTACION.md) and
  [extraction inventory](INVENTARIO_TENTU.md): design history, not deployment evidence.
- [Source provenance](UPSTREAM.json), [third-party notices](../THIRD_PARTY_NOTICES.md)
  and [MIT license](../LICENSE): retained upstream attribution.
- [Account API contract](../apps/account-api/docs/openapi.yaml) and
  [Admin API contract](../apps/admin-api/docs/openapi.yaml).

The realm, application names and visible brand are SCORE. Technical provider IDs,
claims/attributes, package names and native manifest contracts retain selected
`tentu-*`/`tentu.*` identifiers and the protected `administrador` role deliberately.
Renaming them independently would break the producer/consumer contract; their
presence does not cause a connection to Tentu infrastructure.

## Browser session renewal

Account and Admin share one refresh exchange for expiry timers, API calls and
explicit catalogue renewals. A successful refresh updates the user in place,
preserving the route, open view and unsaved form/search state. An expired stored
access token is renewed on initialization when a refresh session is available.
A delayed 401 retries once with the latest token, or one coordinated renewal;
only rejection of the current renewed token ends that session. Definitive OIDC
session errors also end it. Transient renewal failures retain the view and retry
without redirecting to sign-in. API authorization and live permission checks are
unchanged; 403 responses do not trigger renewal.

## Security event search

Security events use the same search, refresh and Previous/Next controls, with 25
rows per page. The text query matches event types (including names with spaces),
application identifiers, user IDs, IP addresses and error codes, and combines with
the event-type selector. Filtering happens on the server before matching rows are
paginated, across provider pages. Raw event details and token/code values are not
searched or returned. A search exceeding 100,000 examined events or ten seconds
fails with a refinement message instead of returning a partial page.

## Shared interface controls

Both web clients use Tailwind CSS 4 through the Vite plugin, together with shared
component CSS in `packages/ui/src/styles.css`. Control borders, focus colors and
picker shadows have light/dark tokens. Text fields, searches, text areas, buttons,
checkboxes and radios share the same control finish and native form semantics.
Single selects retain native markup and keyboard operation. Browsers supporting
`appearance: base-select` also receive the styled top-layer menu, selected-option
checkmark and hover/focus states; other browsers keep a native picker with a styled
closed control. Forced-color checkboxes/radios fall back to browser rendering.

The native authentication theme uses the same self-hosted Source Sans Pro fonts and
control tokens as Account/Admin. It retains larger 48px authentication targets,
native validation, OTP autofill/auto-submit, passkey and authenticator flows. Its
stylesheet version changes when the theme changes to avoid stale cached controls.
Table panel actions align to the title/description block; searches fill available
space between their leading search icon and trailing refresh action. Event-type
filters move below the search on small screens, and permission totals appear in
the pagination rather than reducing the search field width.
