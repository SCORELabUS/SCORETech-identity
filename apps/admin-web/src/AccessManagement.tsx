import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Eye,
  KeyRound,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Button,
  Dialog,
  Empty,
  Field,
  Loading,
  Notice,
  Panel,
  config,
  useAuth,
  useResource,
  useTask,
} from "@scoretech/ui";
import "./AccessManagement.css";

export interface Permission {
  name: string;
  description: string;
}
interface AccessRule {
  id: string;
  clientId: string;
  origin: string;
  requiredPermissions: string[];
}
export interface Catalogue {
  permissions: Permission[];
  roles: { name: string; description: string; permissions: string[] }[];
  groups: { name: string; roles: string[] }[];
  defaultRole?: string;
  accessRules?: AccessRule[];
}
export interface Current {
  baseSha: string;
  catalogue: Catalogue;
  capabilities?: { managePermissions: boolean; manageAccessRules: boolean };
}
interface EnvironmentStatus {
  environment: string;
  state: string;
  detail?: string;
  desiredRevision?: string | null;
  observedRevision?: string | null;
}
type PublicationState = "idle" | "saving" | "waiting" | "applied" | "failed";
const catalogueUrl = config.adminApiUrl + "/catalogue";
const identifier = /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)*$/;
const protectedClients = new Set([
  "account",
  "account-console",
  "admin-cli",
  "broker",
  "realm-management",
  "security-admin-console",
]);

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(new Error("Verification was interrupted."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, 1000);
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}

function useCataloguePublication() {
  const { api, renew } = useAuth();
  const task = useTask();
  const [state, setState] = useState<PublicationState>("idle");
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => active.current?.abort(), []);
  const publish = (
    current: Current,
    catalogue: Catalogue,
    reason: string,
    stored: () => void,
    verified?: () => void,
  ) => {
    if (task.busy || active.current) return;
    void task.execute("", async () => {
      const controller = new AbortController();
      active.current = controller;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let saved = false;
      let applied = false;
      setState("saving");
      try {
        const result = await api<{
          revision: { revisions: Record<string, string> };
        }>(catalogueUrl + "/revisions", {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            baseSha: current.baseSha,
            catalogue,
            environments: [config.environment],
            sourceEnvironment: config.environment,
            reason: reason.trim(),
          }),
        });
        saved = true;
        stored();
        const expected = result.revision?.revisions?.[config.environment];
        if (!expected)
          throw new Error(
            "The change was saved, but its application revision could not be verified. Refresh the catalogue before making another change.",
          );
        setState("waiting");
        timeout = setTimeout(() => controller.abort(), 60_000);
        while (!controller.signal.aborted) {
          const page = await api<{ environments: EnvironmentStatus[] }>(
            catalogueUrl + "/environments",
            { signal: controller.signal },
          );
          const status = page.environments.find(
            (item) => item.environment === config.environment,
          );
          if (status?.state === "failed")
            throw new Error(
              "The change was saved, but Keycloak could not apply it. " +
                (status.detail ||
                  "Review the configuration and publish a correction."),
            );
          if (
            status?.state === "applied" &&
            status.observedRevision === expected
          ) {
            applied = true;
            clearTimeout(timeout);
            await renew();
            setState("applied");
            verified?.();
            return;
          }
          await pause(controller.signal);
        }
        throw new Error("Application verification timed out.");
      } catch (cause) {
        setState("failed");
        if (applied)
          throw new Error(
            "The change was applied and verified, but your session could not be renewed. Sign in again to use the updated permissions.",
          );
        if (saved && controller.signal.aborted)
          throw new Error(
            "The change was saved, but application was not verified within 60 seconds. It may still be pending. Refresh the catalogue before making another change.",
          );
        if (
          saved &&
          !(
            cause instanceof Error &&
            cause.message.startsWith("The change was saved")
          )
        )
          throw new Error(
            "The change was saved, but application could not be verified. " +
              (cause instanceof Error
                ? cause.message
                : "Refresh the catalogue to review its status."),
          );
        throw cause;
      } finally {
        clearTimeout(timeout);
        if (active.current === controller) active.current = undefined;
      }
    });
  };
  return { ...task, state, publish };
}

function PublicationNotice({ state }: { state: PublicationState }) {
  if (state === "saving")
    return <Notice tone="info" message="Saving the catalogue change…" />;
  if (state === "waiting")
    return (
      <Notice
        tone="info"
        message="The change is saved. Waiting for Keycloak to apply and verify this revision…"
      />
    );
  if (state === "applied")
    return (
      <Notice
        tone="success"
        message="The change has been applied and verified. Your session permissions are up to date."
      />
    );
  return null;
}

function ReasonField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field
      label="Reason for this change"
      hint="At least 8 characters. The reason is recorded with this revision."
    >
      <textarea
        required
        minLength={8}
        maxLength={300}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

export function PermissionsPage() {
  const current = useResource<Current>(
    catalogueUrl + "?environment=" + config.environment,
  );
  const publication = useCataloguePublication();
  const [search, setSearch] = useState("");
  const [first, setFirst] = useState(0);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState<Permission>();
  const [deleting, setDeleting] = useState<Permission>();
  const canManage = current.data?.capabilities?.managePermissions === true;
  const query = search.trim().toLowerCase();
  const permissions =
    current.data?.catalogue.permissions.filter((permission) =>
      `${permission.name} ${permission.description}`
        .toLowerCase()
        .includes(query),
    ) ?? [];
  const offset = Math.min(
    first,
    Math.max(0, Math.ceil(permissions.length / 25) - 1) * 25,
  );
  const page = permissions.slice(offset, offset + 25);
  const usingRoles = viewing
    ? (current.data?.catalogue.roles.filter((role) =>
        role.permissions.includes(viewing.name),
      ) ?? [])
    : [];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!current.data || !canManage || publication.busy) return;
    const atom = name.trim();
    if (!identifier.test(atom) || !atom.includes(":"))
      return setError(
        "Use a permission name with a service namespace, such as sphere:admin.",
      );
    if (
      current.data.catalogue.permissions.some(
        (permission) => permission.name === atom,
      ) ||
      current.data.catalogue.roles.some((role) => role.name === atom)
    )
      return setError("That name already exists in the catalogue.");
    if (reason.trim().length < 8)
      return setError("Enter a reason with at least 8 characters.");
    setError("");
    publication.publish(
      current.data,
      {
        ...current.data.catalogue,
        permissions: [
          ...current.data.catalogue.permissions,
          { name: atom, description: description.trim() },
        ],
      },
      reason,
      () => {
        setCreating(false);
        setName("");
        setDescription("");
        setReason("");
        current.reload();
      },
    );
  };
  return (
    <>
      {creating ? null : publication.feedback}
      <PublicationNotice state={publication.state} />
      <Panel
        title="Permission catalogue"
        description="Declare the individual permissions that your services understand. Roles group these permissions and assign them to people."
        actions={
          canManage ? (
            <Button
              disabled={publication.busy}
              onClick={() => {
                setError("");
                setCreating(true);
              }}
            >
              <Plus size={17} /> Create permission
            </Button>
          ) : undefined
        }
      >
        {current.error ? <Notice message={current.error} /> : null}
        {!canManage && current.data ? (
          <p className="access-readonly-note">
            <LockKeyhole size={15} aria-hidden="true" /> Only an identity
            administrator can declare new permissions.
          </p>
        ) : null}
        <div className="access-toolbar">
          <label className="access-search">
            <Search size={19} aria-hidden="true" />
            <input
              aria-label="Search permissions"
              type="search"
              placeholder="Search permissions or descriptions…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setFirst(0);
              }}
            />
          </label>
          <Button
            variant="quiet"
            aria-label="Refresh permissions"
            onClick={current.reload}
          >
            <RefreshCw size={17} />
          </Button>
        </div>
        {current.loading && !current.data ? (
          <Loading />
        ) : permissions.length ? (
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Permissions table"
          >
            <table aria-label="Permission catalogue">
              <thead>
                <tr>
                  <th scope="col">Permission</th>
                  <th scope="col">Description</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {page.map((permission) => (
                  <tr key={permission.name}>
                    <td>
                      <div className="person-cell">
                        <KeyRound size={19} aria-hidden="true" />
                        <div>
                          <strong>
                            <code>{permission.name}</code>
                          </strong>
                          <small>
                            <Badge>{permission.name.split(":")[0]}</Badge>
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="muted text-small">
                        {permission.description || "No description provided."}
                      </span>
                    </td>
                    <td>
                      <div className="button-group">
                        <Button
                          variant="quiet"
                          aria-label={"View permission " + permission.name}
                          title="View permission"
                          onClick={() => setViewing(permission)}
                        >
                          <Eye size={17} />
                        </Button>
                        {canManage ? (
                          <Button
                            variant="quiet"
                            className="catalogue-delete-action"
                            aria-label={"Delete permission " + permission.name}
                            title={
                              isProtectedPermission(permission.name)
                                ? "Internal permission is protected"
                                : "Delete permission"
                            }
                            disabled={
                              isProtectedPermission(permission.name) ||
                              publication.busy
                            }
                            onClick={() => setDeleting(permission)}
                          >
                            <Trash2 size={17} />
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !current.error ? (
          <Empty
            title={
              query ? "No matching permissions" : "No permissions declared"
            }
          >
            <span>
              {query
                ? "Try another name or description."
                : "Create a permission before adding it to a role or access rule."}
            </span>
          </Empty>
        ) : null}
        <div className="pagination">
          <span>
            Showing {permissions.length ? offset + 1 : 0}–{offset + page.length}{" "}
            of {permissions.length}
          </span>
          <div className="button-group">
            <Button
              variant="secondary"
              disabled={offset === 0 || current.loading}
              onClick={() => setFirst(Math.max(0, offset - 25))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              disabled={offset + 25 >= permissions.length || current.loading}
              onClick={() => setFirst(offset + 25)}
            >
              Next
            </Button>
          </div>
        </div>
      </Panel>
      <div className="access-explainer">
        <ShieldCheck size={21} aria-hidden="true" />
        <p>
          Declaring a permission makes it available to your role catalogue. It
          grants access only where a service or an access rule checks it.
        </p>
      </div>
      {deleting && current.data ? (
        <DeleteCatalogueEntry
          kind="permission"
          entry={deleting}
          current={current.data}
          onClose={() => setDeleting(undefined)}
          onDeleted={() => {
            setDeleting(undefined);
            current.reload();
          }}
        />
      ) : null}
      {viewing ? (
        <Dialog
          title="Permission details"
          onClose={() => setViewing(undefined)}
        >
          <div className="form">
            <Field label="Permission name">
              <input readOnly value={viewing.name} />
            </Field>
            <Field label="Description">
              <textarea
                readOnly
                rows={3}
                value={viewing.description || "No description provided."}
              />
            </Field>
            <p className="muted text-small">
              Existing permission definitions are read only.
            </p>
            <section aria-labelledby="permission-roles-title">
              <h3 id="permission-roles-title">
                {usingRoles.length}{" "}
                {usingRoles.length === 1
                  ? "role references"
                  : "roles reference"}{" "}
                this permission
              </h3>
              <p className="muted text-small">
                Direct references in this catalogue. Composed roles may also
                inherit this permission.
              </p>
              {usingRoles.length ? (
                <ul>
                  {usingRoles.map((role) => (
                    <li key={role.name}>
                      <strong>
                        {role.name === "administrador"
                          ? "Admin"
                          : role.description || role.name}
                      </strong>{" "}
                      <code>{role.name}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted text-small">
                  No roles reference this permission directly.
                </p>
              )}
            </section>
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setViewing(undefined)}>
                Close
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {creating ? (
        <Dialog
          title="Create permission"
          onClose={() => {
            if (!publication.busy) setCreating(false);
          }}
        >
          <form className="form" onSubmit={submit}>
            <Notice message={error || publication.error} />
            <Field
              label="Permission name"
              hint="Use your service namespace, for example sphere:admin. Identity namespaces are reserved."
            >
              <input
                required
                maxLength={150}
                placeholder="sphere:admin"
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field
              label="Description"
              hint="Explain the operation or access this permission represents."
            >
              <textarea
                required
                maxLength={500}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <ReasonField value={reason} onChange={setReason} />
            <p className="access-modal-note">
              The permission is added to the catalogue. The identity
              administrator scope is maintained by the server.
            </p>
            <div className="form-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={publication.busy}
                onClick={() => setCreating(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={publication.busy || reason.trim().length < 8}
              >
                Create permission
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

const protectedDomains = new Set([
  "identity",
  "admin-web",
  "account",
  "account-console",
  "admin-cli",
  "broker",
  "keycloak",
  "realm-admin",
  "realm-management",
  "security-admin-console",
  "system",
]);
function isProtectedPermission(name: string) {
  const domain = name.split(":")[0];
  return (
    protectedDomains.has(domain) ||
    domain.startsWith("identity-") ||
    domain.startsWith("default-roles-")
  );
}

export function DeleteCatalogueEntry({
  kind,
  entry,
  current,
  onClose,
  onDeleted,
}: {
  kind: "role" | "permission";
  entry: { name: string; description: string };
  current: Current;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const publication = useCataloguePublication();
  const [reason, setReason] = useState("");
  const { api } = useAuth();
  const [applications, setApplications] =
    useState<{ name: string; requiredPermissions: string[] }[]>();
  const [dependencyError, setDependencyError] = useState(false);
  useEffect(() => {
    if (kind !== "permission") return;
    const controller = new AbortController();
    void api<{
      applications: { name: string; requiredPermissions: string[] }[];
    }>(config.adminApiUrl + "/applications", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setApplications(value.applications);
      })
      .catch(() => {
        if (!controller.signal.aborted) setDependencyError(true);
      });
    return () => controller.abort();
  }, [api, kind]);
  const references = current.catalogue.roles
    .filter(
      (role) =>
        role.name !== "administrador" &&
        role.name !== entry.name &&
        role.permissions.includes(entry.name),
    )
    .map((role) => role.description || role.name);
  if (kind === "role")
    references.push(
      ...current.catalogue.groups
        .filter((group) => group.roles.includes(entry.name))
        .map((group) => "Group: " + group.name),
    );
  if (kind === "permission") {
    references.push(
      ...(current.catalogue.accessRules ?? [])
        .filter((rule) => rule.requiredPermissions.includes(entry.name))
        .map((rule) => "Access rule: " + rule.id),
    );
    references.push(
      ...(applications ?? [])
        .filter((app) => app.requiredPermissions.includes(entry.name))
        .map((app) => "Application: " + app.name),
    );
  }
  const protectedEntry =
    kind === "role"
      ? entry.name === "administrador" ||
        entry.name === (current.catalogue.defaultRole ?? "member")
      : isProtectedPermission(entry.name);
  const blocked =
    protectedEntry ||
    references.length > 0 ||
    (kind === "permission" && (!applications || dependencyError));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (blocked || publication.busy || reason.trim().length < 8) return;
    const catalogue =
      kind === "role"
        ? {
            ...current.catalogue,
            roles: current.catalogue.roles.filter(
              (role) => role.name !== entry.name,
            ),
          }
        : {
            ...current.catalogue,
            permissions: current.catalogue.permissions.filter(
              (permission) => permission.name !== entry.name,
            ),
            roles: current.catalogue.roles.map((role) =>
              role.name === "administrador"
                ? {
                    ...role,
                    permissions: role.permissions.filter(
                      (permission) => permission !== entry.name,
                    ),
                  }
                : role,
            ),
          };
    publication.publish(current, catalogue, reason, () => {}, onDeleted);
  };
  return (
    <Dialog
      title={"Delete " + kind}
      onClose={() => {
        if (!publication.busy) onClose();
      }}
    >
      {publication.feedback}
      <form onSubmit={submit} className="form">
        <div>
          <strong>{entry.description || entry.name}</strong>
          <p>
            <code>{entry.name}</code>
          </p>
        </div>
        <p>
          {kind === "role"
            ? "This removes the role from the active catalogue and revokes its access grants. Member accounts are kept."
            : "This removes the permission from the catalogue and Admin. Existing access tokens may retain it until they expire."}
        </p>
        {protectedEntry ? (
          <Notice message="This built-in definition is protected and cannot be deleted." />
        ) : null}
        {references.length ? (
          <Notice
            message={
              "Remove these references before deleting: " +
              references.join(", ") +
              "."
            }
          />
        ) : null}
        {kind === "permission" && !applications && !dependencyError ? (
          <Loading />
        ) : null}
        {dependencyError ? (
          <Notice message="Application dependencies could not be verified. Close and try again." />
        ) : null}
        <ReasonField value={reason} onChange={setReason} />
        <div className="form-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={publication.busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={blocked || publication.busy || reason.trim().length < 8}
          >
            <Trash2 size={17} /> Delete {kind}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
