# Local implementation verification

Initial record: 2026-11-05. Updated local implementation checks: 2026-11-06.
These checks are separate from deployment of the public server. Initial empty-state
startup, database restoration and production packaging below retain their original
2026-11-05 evidence; the current workspace/provider and laboratory checks were rerun.

| Check                                         | Observed result                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check`, Node 24.14.0 / pnpm 10.9.0      | Build, types and lint pass; 447 package tests plus 11 tooling tests pass (four Linux-only tests skipped on macOS)                                      |
| Configuration and coordination tests in Linux | 15 pass, including exclusive kernel locking and recovery after parent-process death                                                                    |
| Provider Maven tests in Docker                | 144 pass, zero failures; one optional generated-registry contract test is skipped without its system property                                          |
| First `./lab up` with empty state             | Separate project/database initializes the realm and all application services successfully                                                              |
| HTTP smoke checks                             | Triplet/discovery reachable; APIs require authentication; native administration and removed features are inaccessible                                  |
| PostgreSQL logical restoration                | Restored into a new disposable database; SCORE realm and all three provider extension tables present; disposable database removed                      |
| Production packaging                          | Compose configuration parses; reconciliation image builds, runs as UID 1000 and excludes the local server/test suite; live deployment is not performed |

The current smoke checks also verify API service identities. The gateway refreshes
Docker DNS when upstream containers are recreated. Realm reconciliation, catalogue
synchronization and administrative mutations share the authorization lock.

The browser harness exercises real Keycloak, OAuth code/PKCE redirects under
`/identity`, captured email delivery, native virtual WebAuthn and the real provider
authorization registry. The GitHub-compatible server is an isolated local fixture;
it uses the same catalogue adapter but does not prove access to a real installation.

Completed browser paths include public email verification/registration, profile
persistence, security/sessions, SSO between Account and Admin, refusal of an
ordinary member, role publication/application, role assignment, mandatory passkey
onboarding for a delegated administrator, and invitation creation/edit/revocation.
Native TOTP setup also completes after passkey reauthentication and returns to
the original Security section. Invitation editing is checked in a non-UTC browser timezone without changing the
stored expiry. Dark and mobile layouts are captured for inspection.

The 2026-11-06 browser run also passed permission creation and exact-origin access
rule publication through the protected compatibility API. It proved service denial before a grant, real SSO
and PKCE exchange after a role grant, RS256/JWKS signature plus issuer/audience/
subject validation, and an access token containing only that service's required
atomic permission. Removing the permission rejected both a stored refresh token
and a new SSO authorization. Cleanup removed only the run-owned rule and grants;
additive test permissions and catalogue history remain. The protocol fixture
captures the exact registered callback and state, including a terminal redirect
URL when Playwright does not route redirected network requests.

The avatar dropdown, keyboard dismissal, method counts, credential detail views,
last administrative passkey protection, native authenticator setup, saved theme
across reload and the preferences mockup are exercised by the same browser run.

Application management is covered by the same browser run: Admin creates a public
client and a confidential client with generated IDs and exact callback settings.
The public client completes real PKCE without a secret and refuses a member
without the required permission. The confidential client refuses a token request
without its secret; rotation rejects the previous secret and accepts the new one.
List responses contain no secret. Setup details, versioned edit, disable/refresh
rejection and mobile overflow are checked. Generated test clients remain disabled
after cleanup; only their public metadata and check names enter the proof files.
Secrets and tokens are never written into the evidence artifacts. A subsequent
`./lab up` preserved both disabled test applications and their required permissions;
the final Linux/HTTP smoke checks also passed.

Editable application types are now verified in both directions with a stable
client ID. A public-to-backend transition presents a new copyable secret once;
a backend-to-public transition removes it. Both transitions reject the old refresh
tokens and require reauthentication for affected SSO sessions. The native suite
also checks that unspent old authorization codes cannot be revived after a type
change. The browser keeps the new secret dialog available until explicitly closed,
even when the editing administrator's own SSO session ends. Rotation is exercised
from connection details. Modal buttons are checked in DOM/visual order with Cancel
to the left of the primary action; Account/Admin share right-aligned action styling.

Connection details now starts with credentials. The browser proof explicitly
reveals a disposable backend client's current secret, compares it without printing
its value, verifies the copy control, hides it and reopens the dialog to confirm it
has been cleared. Reveal leaves the secret/version unchanged and list metadata
secret-free; provider and HTTP tests enforce protected JWT/passkey access and
no-store responses. Screenshots use masked fields. The Access rules page and menu
entry are removed; its old hash redirects to Applications. Legacy policies retain
backend/API compatibility coverage instead of a separate UI.

The current browser run also verifies application deletion: Cancel and backdrop
dismissal send no deletion request; confirmation removes a disposable client and
rejects its stored refresh token. Native tests cover stale versions, ownership,
session cleanup and preservation of unrelated clients and users. Shared dialogs
close on a backdrop click, while clicks on interior padding and drags beginning
inside leave them open.

Invitations also use a table with status, role grants, usage, expiry and edit/revoke
actions. The browser flow edits the expiry-preserving invitation from its table row.
Revocation and permanent deletion both require confirmation; cancellation preserves
the invitation, and deletion is checked for both revoked and naturally expired
fixtures. An active invitation deletion returns 409. Native tests prove the state
check runs under the same row lock as redemption and preserves registration evidence.
The redundant top header is removed from both consoles; the browser verifies mobile
navigation still opens and closes and My profile is available in the Admin dropdown.
Role and permission deletion use separate confirmation dialogs and audit reasons.
Admin and the registration baseline are protected; referenced definitions must be
detached before deletion. Server tests cover protected permission namespaces,
ordinary-role and legacy-policy references, live managed-application dependencies
(including disabled clients), dependency lookup failure and delegated deletion
refusal. Native reconciliation checks managed application dependencies before any
role mutation. The browser test cancels both deletions, confirms only its own
disposable role and permission, verifies their removal and Admin's updated grants,
and rejects direct deletion of Admin or an application's required permission.

Roles and permissions now use tables with action controls. The browser checks
permission details and the role editor, the protected role's display name `Admin`,
and automatic inclusion of a newly declared permission without renewing the
administrator's previous token. Catalogue, role-assignment and native invitation
tests preserve signed/live operation checks and delegated-operator bounds while
allowing the live protected administrator to delegate newly declared permissions.
Account shows Administration only for the live protected Admin role; ordinary
members and delegated administrators do not receive that link. Admin has no separate Account navigation link; its user dropdown includes My profile and Sign out. Visual inspection confirms the single-chevron banner
and red Sign out action in the updated laboratory.

Role and invitation pagination are exercised with 26 run-owned fixtures in each
table. Search, refresh, next/previous pages and empty invitation results are checked;
invitation filtering runs before the provider's pagination. Fixture invitations are
allowed to expire and are deleted; fixture roles are retired in a new audited revision.
The browser accelerates only local access-token expiry metadata and observes a real
refresh-token exchange after one deliberately interrupted network request. It verifies
the Admin route and typed search survive and the sign-in screen never replaces them.
Unit tests cover concurrent renewal coalescing, late 401 responses, expired-token
recovery, transient failures, revoked sessions and permission denials.

Run `pnpm test:e2e` to reproduce the browser check; output and screenshots go to
`test-results/triplet/` and are ignored by Git. Fixture test accounts are removed
afterward; published test roles and revision history remain available in the lab.
Email-code retries respect the provider's resend cooldown.

Passkeys were exercised with virtual authenticators; a real-device ceremony is
still required before production release. Real Brevo SMTP delivery, GitHub App
installation, the existing host's capacity/TLS proxy, production backups,
multi-host coordination and SPHERE/SPACE migration are not claimed as verified.
The checked-in CI workflow has not been run on GitHub as part of this local work.

Permissions and Applications also paginate their complete filtered lists in groups
of 25. The local browser inspection verified permission pages 1–25 and 26–42,
Previous/Next boundaries, and a search reset to 1–1. The current application list
of 18 entries correctly disables both navigation buttons. Both consoles share a
footer displaying © and the year calculated from the browser's current date. The
workspace build passes after these interface changes. Existing browser fixtures
select their own records through search so actions also work beyond the first page.

Security-event tests cover text matches beyond the first provider page, matching
before pagination, combined native filters, safe-field-only search, direct
pagination without a text query, oversized search refusal and API query validation.
The search retains the existing event projection and permission requirements.
The local browser inspection also verified event pagination, the 0–0 empty state,
and a combined LOGIN / identity-admin-web search that retained Previous/Next
controls. The updated APIs and gateway are running in the local laboratory.

The sidebar reserves space for its active marker and uses slightly wider desktop,
tablet and mobile widths. Browser measurements confirmed every navigation row
remains 46.8 px tall, including active/inactive Roles and permissions, at the
default viewport and at 1000 px and 390 px widths, without horizontal overflow.
The frontend build passes and the laboratory gateway includes the CSS fix.

Shared-control refinement was checked in the actual event-type filter and an
unsaved Create application dialog. Native Down/Return selected Browser application;
Escape dismissed the picker while keeping the dialog open. The draft was cancelled.
A temporary preview using the compiled CSS verified dark states, disabled and
read-only controls, checkbox/radio selection and a 390 px layout without horizontal
overflow. User theme preferences were not changed. Workspace/frontend builds pass;
the temporary preview server/tab were closed and the gateway has the shared styles.

The authentication theme now self-hosts Source Sans Pro (OFL license included),
aligns its light/dark control tokens with both web clients and uses the same
rounded field/button/checkbox/select finish. The native theme stylesheet version
was incremented to avoid stale caches. Browser captures cover email entry, email
codes and public registration in light/dark modes and at 390px; the checkbox label
geometry is checked to prevent Remember me text overlap. Captures disable finite
animations so theme-transition frames are not mistaken for final dark colors.
The login wordmark uses the same sans-serif family as the application.

Panel heading/action centers were checked in Users, Invitations, Roles, Permissions
and Applications (less than 1px difference). All six table searches use the full
available row, with refresh at its right edge. Event type moves to a second row
on small screens. Desktop and 390px browser checks confirmed no page overflow;
the local frontend build and Linux/HTTP laboratory checks pass.
