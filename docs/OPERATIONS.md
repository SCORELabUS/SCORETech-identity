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

The catalogue is stored in PostgreSQL and managed through the provider's private
`score-catalogue` API. Role/permission changes and their audit history commit in
one native transaction. A once-only initializer imports an existing local lab's
verified legacy catalogue/history; subsequent starts retain the current database
state. No GitHub App, fixture service or background synchronizer is required.
The gateway refreshes Docker DNS for recreated services. Deployment and Admin
mutations retain their shared kernel lock file; preserve its inode.

## Production prerequisites, secrets and startup

The canonical deployment instructions are in [docker/README.md](../docker/README.md).
Use `./docker/setup production`, configure `docker/production/.env`, then run Compose from `docker/production`. Staging has an independent
entry point and state. The Docker guide also covers preparation preview, shared
SPHERE networking, both callbacks and rollback.

Compose now mounts internal/Brevo credentials from the private `.env` as secrets.
For existing deployments using individual secret files, transfer their **existing
values** to the corresponding `.env` variables; do not change persisted database
or service credentials. Runtime private files remain restricted; public configuration lives only
in the `web` subdirectory. Native bootstrap access stays private and separate from
the first SCORE operator, who proves email ownership and enrolls a passkey.

Rendering, native realm reconciliation and database catalogue initialization run
automatically as startup dependencies. Existing users, credentials, roles and
audit history are retained. Public terms/privacy are bundled and rendered under
`/identity/legal/`; no external legal host or operator-supplied digests are needed.

For maintenance examples later in this guide, define from the repository root:

```bash
production() {
  docker compose --project-directory "$PWD/docker/production" \
    -f "$PWD/docker/production/compose.yaml" "$@"
}
```

Keep the server on released main and back up persistent state before upgrades. First startup
requires the existing SPHERE network. Verify actual HTTPS, Brevo,
external SSO and backup/restore on the target host before admitting real traffic.

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

PostgreSQL/Keycloak owns the live catalogue and its revision history. Admin uses
the private native service API, which enforces a compare-and-save revision check
and commits the role graph, token scope changes, application rules and audit
record in one database transaction. `baseSha` remains the API field name for
compatibility, but is now a 64-character database revision identifier, not a Git SHA.

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

Every change includes a reason of at least eight characters and the base database
revision. A successful save is active immediately; stale editors receive 409 and
a failed native write rolls back the registry, roles and audit entry together.
History is stored in `SCORE_CATALOGUE_REVISION` and restores are new audited changes.
Account and Admin read the live database catalogue, never a generated projection.

The deployment setup client retains realm/client-management capability for
once-only managed configuration, separate from normal browser credentials. Admin
mutations retain their process queue and kernel `flock` for user-management
coordination and fresh live-authority checks. Native catalogue saves also use the
provider transaction lock. Preserve the shared coordination file inode.

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
`smtp-relay.brevo.com:587` with STARTTLS by default, using the private
`BREVO_SMTP_LOGIN` and `BREVO_SMTP_KEY` values mounted as secrets.
`BREVO_SMTP_PORT` also accepts 2525 (STARTTLS) and 465 (implicit TLS). Set the
authenticated sender email and the public sender name
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
production stop gateway account-api admin-api catalogue-init realm-setup keycloak
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

## Google and Universidad de Sevilla sign-in

Both are upstream identity providers of Keycloak. Applications still consume the
SCORETech Identity OIDC issuer; neither provider grants application/Admin permissions.
External sign-in retains explicit legal consent, safe baseline roles, and mandatory
administrative passkeys. A successful upstream login does not require another
mailbox challenge. The native VERIFY_EMAIL action is skipped only for that
server-attested, user-bound broker transaction; local flows and explicitly
requested verification retain their native behavior. CAS email remains unverified
unless mailbox ownership is proved separately. Existing-account linking requires
confirmation and mailbox verification; matching email is never silently trusted.
US identity keys are UVUS identifiers, not email addresses.

Configuration is optional and private: copy `config/external-sso.example.json` to
`.lab/external-sso.json` for the lab, or `.identity-runtime/external-sso.json` for
production. Keep the file readable by the rendering process only (production UID
1000, mode 0600). It contains the Google secret and must never enter Git, web config,
logs or screenshots. Missing configuration leaves both providers disabled. Set
`google.enabled` to true only after supplying its real client ID and secret. The
current workstation's `.lab/external-sso.json` already contains SPHERE's Google
client ID, an empty secret, and its US CAS configuration. Google is disabled until
the operator fills `google.clientSecret` and enables it. Run `./lab up` afterwards.
For production, rerender then run the documented realm reconciliation step; realm
import alone does not update an existing realm. Owned broker configuration is
reconciled without deleting accounts, credentials or linked identities. Removing
an owned provider from configuration disables it, preserving existing links.

### Google local testing

Google uses Keycloak's native Google broker. Reuse SPHERE's client ID/secret, but
add this authorized redirect URI to that Google Cloud OAuth client for local tests:

```
http://localhost:18000/identity/auth/realms/score/broker/google/endpoint
```

For the initial public deployment register:

```
https://sphere.score.us.es/identity/auth/realms/score/broker/google/endpoint
```

The SPHERE Google callback is not interchangeable with the native Keycloak
callback. Google must explicitly allow the appropriate URI. No public deployment
is required for Google once its localhost callback and consent/test-user settings
permit the account. Real Google sign-in is not verified without that secret.

### US CAS compatibility callback and gateway

The CAS broker defaults to `https://sso.us.es/CAS` and accepts the already approved
SPHERE callback from `us.callbackUrl`:

```
https://sphere.score.us.es/api/v1/users/auth/sso/us/callback
```

The inner Identity gateway includes that exact compatibility route, redirecting the browser to
`/identity/auth/realms/score/broker/us-sso/endpoint` with query parameters preserved.
This extra same-origin redirect is intentional: the browser only sends the native
authentication cookie on the realm path, not on SPHERE's `/api/` path.
CAS ticket validation uses the identical externally visible service URL, including
the transaction state. State starts with `sti.` and is then validated against the
native Keycloak authentication session; the prefix itself grants no authority.
Tickets, XML attributes and states must not be logged.

At the outer SPHERE gateway, when SPHERE no longer starts direct CAS sign-ins,
route only this callback to the loopback Identity gateway (default production port
18010). Keep the `/identity/` route as documented. Example inside its server block:

```nginx
location = /api/v1/users/auth/sso/us/callback {
    proxy_pass http://127.0.0.1:18010;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
}
```

If that proxy runs in Docker, use a reachable gateway service address instead of
its own container's loopback. While SPHERE still starts direct CAS logins, dispatch
only `state` values beginning with `sti.` to Identity and leave others on SPHERE.
Do not steal callbacks of in-progress SPHERE logins. No outer SPHERE proxy has
been changed automatically by implementing this integration.

Real US sign-in cannot complete against an ordinary localhost-only lab while its
approved callback points to the public SPHERE host. Deploy Identity behind that
host/gateway, or arrange a controlled HTTPS test environment serving the complete
public Identity origin and callback consistently. Tunneling only the callback to
localhost is insufficient because broker cookies and public issuer URLs must
also agree. Do not change the live gateway just to run the local regression suite.
The Java suite uses a local CAS fixture to exercise validation, malformed XML,
transaction state and replay rejection without contacting the US. A future SAML
migration must explicitly preserve each UVUS-to-account link.

If upgrading an existing production realm created before external SSO support,
the native operations administrator must first grant `realm-management` →
`manage-identity-providers` to the **identity-config-sync service account**. Fresh
production imports include it. Do not grant that capability to browser clients.
The existing `manage-realm` capability remains required for flow reconciliation.

### Managing linked sign-in identities

Account → Security → Connected identities lists Google and Universidad de Sevilla
with connection state and the provider's linked username. Connect uses the native
`idp_link:<alias>` action; the provider proves possession and Keycloak rejects an
identity owned by another account. Linking does not merge existing accounts or
change service permissions. The callback returns to `#security/identities`.

Disconnect uses `score-unlink-identity:<alias>`, requires fresh authentication and
a native confirmation page, and rechecks remaining methods under the shared
credential-mutation lock. Only verified email OTP, a local passkey/authenticator whose complete local login
flow is usable, or another enabled sign-in provider counts as fallback. When realm
email verification is required, an unverified mailbox does not become a usable
local fallback merely by adding a passkey or authenticator. The view offers explicit
email verification when needed. Disabled/link-only
providers and unverified CAS email do not count. Administrative passkey rules
remain in force. The Account API only forwards the caller's signed bearer to the
private native metadata endpoint; provider tokens/secrets are never returned.

Realm reconciliation enables the two actions and grants the narrowly scoped native
`account.manage-account-links` role through the realm default role and Account Web
client scope. The native Account console stays disabled and its REST path is blocked by the
public gateway, so native unlink endpoints cannot bypass the last-method guard.
No `manage-account` or
administrative browser privilege is granted. Rerender and reconcile after upgrading
an existing realm. Native operators must ensure users retain the realm default
role; deliberately stripped accounts do not gain linking authority automatically.

## Browser session renewal and cross-console SSO

Access tokens expire after five minutes; this is distinct from the native SSO
session. The checked-in realm allows 12 hours of SSO inactivity and a seven-day
absolute session maximum; Remember me uses 30 days idle and 90 days maximum.
A suspended browser may stop running renewal timers. Account and Admin therefore
recheck expiry on focus, visibility restoration and page restoration, sharing one
refresh exchange with API requests and timer-driven renewal.

Opening either console without a local token first checks the native same-origin
SSO cookie through OIDC `prompt=none` and its dedicated `auth/silent-callback`.
A rejected console refresh can also recover through that still-valid SSO session
without navigating away or dropping view state. Recovery is bound to the previous
subject; it does not silently replace the user with a different account. Transient
network errors retain the current view and retry. A genuinely ended/revoked native
session, an account change, missing consent or a required administrative passkey
can still require interactive sign-in; renewal never bypasses those checks.

Valid broker-origin SSO cookies retain their server-owned, user-bound origin note
when reused across consoles. A fresh local authentication clears that broker
exemption, preserving native mailbox verification where applicable. The two web
clients' silent callback URIs are managed by realm rendering/reconciliation; the
Google and US upstream callback URLs are unchanged. Rerender and reconcile when
upgrading existing deployments. `pnpm test:e2e:session` exercises cross-console
SSO, background resume, rejected-refresh recovery, retained route/search state
and the normal anonymous sign-in fallback with real Keycloak.

### Shared profile and avatar

Account separates contact details (`#profile`) from the optional shared profile
(`#public-profile`). The latter includes display name, bio (200 characters), city,
country, date of birth and LinkedIn/Instagram/Facebook/X profile links. These are
stored as allowlisted `scoreProfile` and `scoreSocialLinks` user attributes through
the provider's existing atomic field patch. Updating either group leaves contact
data, roles, consent, credentials and the other group intact. Supplying an empty
group clears its optional values. Profile data is only returned to its owner;
this feature does not create a public directory or add optional personal data to
tokens. Each future service integration must define the data it consumes and its
public visibility. SPHERE/SPACE data has not been migrated.

The avatar editor reuses SPHERE's SVG artwork, initials, paginated artwork picker,
foreground/background palettes and `react-easy-crop` workflow. The palette defaults
to SCORETech crimson. Predefined IDs and six-digit hex colors are allowlisted;
existing named colors and earlier avatar descriptors remain readable.

Both Compose deployments mount the persistent `identity-avatars` volume in Account
API and configure `APP_AVATAR_DIRECTORY=/var/lib/identity-avatars`. Include this
volume in backups alongside the database. `./lab down` preserves it. Uploaded
JPEG/PNG/WebP images are limited to 2 MiB and 16 million decoded pixels, stripped
of metadata and normalized server-side to 256×256 WebP. Files are private; the
owner's no-store profile response embeds the image rather than exposing a public
file URL. Replacing a photo removes its previous owned file after the profile
write succeeds. `APP_AVATAR_BUCKET` selects the existing S3 adapter instead when
set; explicit bucket lifecycle rules should clean abandoned uploads.

Account's Danger zone starts `score-delete-account`, a native action restricted
to Account Web, with immediate reauthentication, a CSRF-bound confirmation form
and typed email confirmation. It removes the central identity through Keycloak's
UserManager, including linked identities, roles and native sessions. Administrative
accounts (including delegated administrative access) must have that access removed
first by another administrator; the native action rechecks this policy. The UI
explains that service data, subscriptions and organization ownership must be
managed in the respective services first. No SPHERE/SPACE deletion is triggered.
A deleted identity's unreferenced avatar file should be removed during storage
retention cleanup; it is no longer retrievable through the Account API.
