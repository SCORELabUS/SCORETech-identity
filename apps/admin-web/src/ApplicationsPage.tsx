import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  Eye,
  EyeOff,
  Code2,
  Copy,
  Globe2,
  KeyRound,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
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
import "./ApplicationsPage.css";

type ApplicationKind = "confidential" | "public";
interface Application {
  clientId: string;
  name: string;
  kind: ApplicationKind;
  origin: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  requiredPermissions: string[];
  enabled: boolean;
  version: string;
}
interface ApplicationsResponse {
  applications: Application[];
  issuer: string;
  discoveryUrl: string;
  capabilities: { manageApplications: boolean };
}
interface Permission {
  name: string;
  description: string;
}
interface ApplicationResult {
  application: Application;
  clientSecret?: string;
}
interface SecretResult {
  clientId: string;
  clientSecret: string;
  application?: Application;
}
interface NewSecret {
  clientId: string;
  name: string;
  value: string;
}
const endpoint = config.adminApiUrl + "/applications";
const applicationUrl = (clientId: string) =>
  endpoint + "/" + encodeURIComponent(clientId);
const isApplicationPermission = (name: string) =>
  !["identity:", "admin-web:", "account-web:"].some((prefix) =>
    name.startsWith(prefix),
  );

export function ApplicationsPage() {
  const resource = useResource<ApplicationsResponse>(endpoint);
  const catalogue = useResource<{ catalogue: { permissions: Permission[] } }>(
    config.adminApiUrl + "/catalogue?environment=" + config.environment,
  );
  const [search, setSearch] = useState("");
  const [first, setFirst] = useState(0);
  const [editing, setEditing] = useState<Application | null>();
  const [details, setDetails] = useState<Application>();
  const [rotating, setRotating] = useState<Application>();
  const [deleting, setDeleting] = useState<Application>();
  const [secret, setSecret] = useState<NewSecret>();
  const canManage = resource.data?.capabilities?.manageApplications === true;
  const permissions =
    catalogue.data?.catalogue.permissions.filter((permission) =>
      isApplicationPermission(permission.name),
    ) ?? [];
  const query = search.trim().toLowerCase();
  const applications =
    resource.data?.applications.filter((application) =>
      `${application.name} ${application.clientId} ${application.origin}`
        .toLowerCase()
        .includes(query),
    ) ?? [];
  const offset = Math.min(
    first,
    Math.max(0, Math.ceil(applications.length / 25) - 1) * 25,
  );
  const page = applications.slice(offset, offset + 25);
  const saved = (result: ApplicationResult) => {
    setEditing(undefined);
    if (result.clientSecret)
      setSecret({
        clientId: result.application.clientId,
        name: result.application.name,
        value: result.clientSecret,
      });
    else resource.reload();
  };
  const closeSecret = () => {
    setSecret(undefined);
    resource.reload();
  };
  return (
    <>
      <Panel
        title="Applications"
        description="Register the applications that connect to SCORETech Identity with OpenID Connect."
        actions={
          canManage ? (
            <Button onClick={() => setEditing(null)}>
              <Plus size={17} /> Create application
            </Button>
          ) : undefined
        }
      >
        {resource.error ? <Notice message={resource.error} /> : null}
        {resource.data && !canManage ? (
          <p className="applications-readonly">
            <LockKeyhole size={15} aria-hidden="true" /> Application management
            is available only to an identity administrator.
          </p>
        ) : null}
        <div className="applications-toolbar">
          <label className="applications-search">
            <Search size={19} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search applications"
              placeholder="Search name, client ID or origin…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setFirst(0);
              }}
            />
          </label>
          <Button
            variant="quiet"
            aria-label="Refresh applications"
            onClick={resource.reload}
          >
            <RefreshCw size={17} />
          </Button>
        </div>
        {resource.loading && !resource.data ? (
          <Loading />
        ) : applications.length ? (
          <div
            className="table-wrap applications-table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Applications table"
          >
            <table
              className="applications-table"
              aria-label="Connected applications"
            >
              <thead>
                <tr>
                  <th scope="col">Application</th>
                  <th scope="col">Origin</th>
                  <th scope="col">Permissions</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {page.map((application) => (
                  <tr key={application.clientId}>
                    <td>
                      <div className="applications-table-name">
                        <strong>{application.name}</strong>
                        <code>{application.clientId}</code>
                        <span className="applications-kind">
                          {application.kind === "confidential"
                            ? "Backend application"
                            : "Browser application"}
                        </span>
                      </div>
                    </td>
                    <td>
                      <code className="applications-table-origin">
                        {application.origin}
                      </code>
                    </td>
                    <td>
                      <span className="applications-table-permission-count">
                        {application.requiredPermissions.length}{" "}
                        {application.requiredPermissions.length === 1
                          ? "permission"
                          : "permissions"}
                      </span>
                      <span className="applications-table-permission-hint">
                        All required · View in setup
                      </span>
                    </td>
                    <td>
                      <Badge tone={application.enabled ? "success" : "neutral"}>
                        {application.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </td>
                    <td>
                      <div className="applications-table-actions">
                        <Button
                          variant="quiet"
                          aria-label={"Open setup for " + application.name}
                          title="Connection details"
                          onClick={() => setDetails(application)}
                        >
                          <Code2 size={17} />
                        </Button>
                        {canManage ? (
                          <>
                            <Button
                              variant="quiet"
                              aria-label={
                                "Edit application " + application.name
                              }
                              title="Edit application"
                              onClick={() => setEditing(application)}
                            >
                              <Settings size={17} />
                            </Button>
                            {application.kind === "confidential" ? (
                              <Button
                                variant="quiet"
                                aria-label={
                                  "Rotate secret for " + application.name
                                }
                                title="Rotate secret"
                                onClick={() => setRotating(application)}
                              >
                                <KeyRound size={17} />
                              </Button>
                            ) : null}
                            <Button
                              variant="quiet"
                              className="applications-delete-action"
                              title="Delete application"
                              aria-label={
                                "Delete application " + application.name
                              }
                              onClick={() => setDeleting(application)}
                            >
                              <Trash2 size={17} />
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !resource.error ? (
          <Empty
            title={query ? "No matching applications" : "No applications yet"}
          >
            {query
              ? "Try another name, client ID or origin."
              : "Create an application to get its OIDC client ID and integration settings."}
          </Empty>
        ) : null}
        <div className="pagination">
          <span>
            Showing {applications.length ? offset + 1 : 0}–
            {offset + page.length}
          </span>
          <div className="button-group">
            <Button
              variant="secondary"
              disabled={offset === 0 || resource.loading}
              onClick={() => setFirst(Math.max(0, offset - 25))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              disabled={offset + 25 >= applications.length || resource.loading}
              onClick={() => setFirst(offset + 25)}
            >
              Next
            </Button>
          </div>
        </div>
      </Panel>
      {editing !== undefined && canManage ? (
        <ApplicationForm
          key={editing?.clientId ?? "new"}
          application={editing}
          permissions={permissions}
          permissionsLoading={catalogue.loading}
          permissionsError={catalogue.error}
          onClose={() => setEditing(undefined)}
          onSaved={saved}
        />
      ) : null}
      {details && resource.data ? (
        <ApplicationDetails
          key={details.clientId}
          application={details}
          issuer={resource.data.issuer}
          discoveryUrl={resource.data.discoveryUrl}
          onClose={() => setDetails(undefined)}
          onRotate={
            canManage && details.kind === "confidential"
              ? () => {
                  setDetails(undefined);
                  setRotating(details);
                }
              : undefined
          }
        />
      ) : null}
      {rotating && canManage ? (
        <RotateSecret
          application={rotating}
          onClose={() => setRotating(undefined)}
          onRotated={(result) => {
            setRotating(undefined);
            setSecret({
              clientId: result.clientId,
              name: result.application?.name ?? rotating.name,
              value: result.clientSecret,
            });
          }}
        />
      ) : null}
      {deleting && canManage ? (
        <DeleteApplication
          application={deleting}
          onClose={() => setDeleting(undefined)}
          onDeleted={() => {
            setDeleting(undefined);
            resource.reload();
          }}
        />
      ) : null}
      {secret ? (
        <Dialog title="Save your client secret" onClose={closeSecret}>
          <div className="applications-secret-heading">
            <KeyRound size={27} aria-hidden="true" />
            <div>
              <strong>{secret.name}</strong>
              <p>
                Store this secret on your backend. You can show and copy it
                again from the application’s connection details.
              </p>
            </div>
          </div>
          <ReadOnlyValue label="Client ID" value={secret.clientId} />
          <ReadOnlyValue label="Client secret" value={secret.value} multiline />
          <p className="applications-secret-note">
            Store this secret securely on your application's backend. Never put
            it in browser code, source control or a public configuration file.
          </p>
          <div className="form-actions">
            <Button onClick={closeSecret}>I have saved the secret</Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function ReadOnlyValue({
  label,
  value,
  multiline = false,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const copy = async () => {
    setCopied(false);
    setError("");
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setError(
        "Clipboard access is unavailable. Select and copy the value manually.",
      );
    }
  };
  return (
    <div className="applications-copy-value">
      <div className="applications-copy-control">
        <Field label={label}>
          {multiline ? (
            <textarea
              readOnly
              rows={3}
              autoComplete="off"
              spellCheck={false}
              value={value}
            />
          ) : (
            <input
              readOnly
              autoComplete="off"
              spellCheck={false}
              value={value}
            />
          )}
        </Field>
        <Button
          variant="secondary"
          type="button"
          aria-label={"Copy " + label.toLowerCase()}
          onClick={() => void copy()}
        >
          <Copy size={16} />
          <span>Copy</span>
        </Button>
      </div>
      {copied ? (
        <span className="applications-copy-feedback" role="status">
          Copied to clipboard.
        </span>
      ) : null}
      <Notice message={error} />
    </div>
  );
}

function canonicalOrigin(value: string) {
  try {
    const parsed = new URL(value);
    return (
      value === parsed.origin &&
      !value.includes("*") &&
      !value.includes("\\") &&
      !parsed.username &&
      !parsed.password &&
      (parsed.protocol === "https:" ||
        (config.environment === "local" &&
          parsed.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(parsed.hostname)))
    );
  } catch {
    return false;
  }
}

function parseCallbacks(
  value: string,
  origin: string,
  required: boolean,
): string[] {
  const urls = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if ((required && !urls.length) || urls.length > 10)
    throw new Error(
      required
        ? "Enter between 1 and 10 redirect URLs."
        : "Enter no more than 10 post-logout URLs.",
    );
  if (new Set(urls).size !== urls.length)
    throw new Error("Each callback URL must be unique.");
  for (const value of urls) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Use absolute callback URLs, one per line.");
    }
    if (
      value.length > 2048 ||
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.hash ||
      value.includes("*") ||
      value.includes("\\")
    )
      throw new Error(
        "Every callback must use the application origin. Wildcards, credentials and fragments are not allowed.",
      );
  }
  return urls;
}

function ApplicationForm({
  application,
  permissions,
  permissionsLoading,
  permissionsError,
  onClose,
  onSaved,
}: {
  application: Application | null;
  permissions: Permission[];
  permissionsLoading: boolean;
  permissionsError: string;
  onClose: () => void;
  onSaved: (result: ApplicationResult) => void;
}) {
  const { api } = useAuth();
  const task = useTask();
  const [name, setName] = useState(application?.name ?? "");
  const [kind, setKind] = useState<ApplicationKind>(
    application?.kind ?? "confidential",
  );
  const [origin, setOrigin] = useState(application?.origin ?? "");
  const [redirects, setRedirects] = useState(
    application?.redirectUris.join("\n") ?? "",
  );
  const [logouts, setLogouts] = useState(
    application?.postLogoutRedirectUris.join("\n") ?? "",
  );
  const [required, setRequired] = useState<string[]>(
    application?.requiredPermissions ?? [],
  );
  const [enabled, setEnabled] = useState(application?.enabled ?? true);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const visible = permissions.filter((permission) =>
    `${permission.name} ${permission.description}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase()),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (task.busy || permissionsLoading || permissionsError) return;
    const selectedOrigin = origin.trim();
    let redirectUris: string[];
    let postLogoutRedirectUris: string[];
    try {
      if (!name.trim()) throw new Error("Enter an application name.");
      if (!canonicalOrigin(selectedOrigin))
        throw new Error(
          "Enter a canonical HTTPS origin without a path or trailing slash. HTTP localhost or 127.0.0.1 is allowed only in the local environment.",
        );
      redirectUris = parseCallbacks(redirects, selectedOrigin, true);
      postLogoutRedirectUris = parseCallbacks(logouts, selectedOrigin, false);
      if (!required.length || required.length > 1000)
        throw new Error("Select between 1 and 1000 application permissions.");
      if (
        required.some(
          (name) => !permissions.some((permission) => permission.name === name),
        )
      )
        throw new Error(
          "A selected permission is no longer available. Reload the permission catalogue before saving.",
        );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Review the application settings.",
      );
      return;
    }
    setError("");
    void task.execute("", async () => {
      const result = await api<ApplicationResult>(
        application ? applicationUrl(application.clientId) : endpoint,
        {
          method: application ? "PUT" : "POST",
          body: JSON.stringify({
            name: name.trim(),
            kind,
            origin: selectedOrigin,
            redirectUris,
            postLogoutRedirectUris,
            requiredPermissions: required,
            enabled,
            ...(application ? { version: application.version } : {}),
          }),
        },
      );
      onSaved(result);
    });
  };
  return (
    <Dialog
      title={application ? "Edit application" : "Create application"}
      onClose={() => {
        if (!task.busy) onClose();
      }}
    >
      <form className="form" onSubmit={submit}>
        {task.feedback}
        <Notice message={error} />
        {application ? (
          <Field
            label="Client ID"
            hint="Assigned by the server and cannot be changed."
          >
            <input readOnly value={application.clientId} />
          </Field>
        ) : null}
        <Field label="Name" required>
          <input
            required
            maxLength={150}
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label="Application type"
          required
          hint={
            application
              ? "Changing type updates credentials and ends sign-in sessions that used this application."
              : "Choose where the application runs and how it keeps its credentials."
          }
        >
          <select
            className="cursor-pointer"
            required
            disabled={task.busy}
            value={kind}
            onChange={(event) => setKind(event.target.value as ApplicationKind)}
          >
            <option value="confidential">Backend application</option>
            <option value="public">Browser application</option>
          </select>
        </Field>
        <p className="applications-type-note">
          {kind === "confidential"
            ? "Keeps its client secret on a server. Never place the secret in browser code."
            : "Runs in the browser, uses PKCE S256 and has no client secret."}
        </p>
        {application && kind !== application.kind ? (
          <p className="applications-type-note" role="note">
            Existing sign-in and offline sessions that used this application
            will end, including their SSO connections. You may need to sign in
            again.
            {kind === "confidential"
              ? " A new secret will be shown once after saving."
              : " The existing secret will be removed. Use PKCE without a secret."}
          </p>
        ) : null}
        <Field
          label="Application origin"
          required
          hint="One exact HTTPS origin with no trailing slash or path. HTTP loopback is allowed only locally."
        >
          <input
            required
            type="url"
            maxLength={2048}
            autoComplete="off"
            placeholder="https://service.score.us.es"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
          />
        </Field>
        <Field
          label="Redirect URLs"
          required
          hint="One exact callback URL per line, on the application origin. Between 1 and 10 URLs; no wildcards."
        >
          <textarea
            required
            rows={3}
            placeholder="https://service.score.us.es/auth/callback"
            spellCheck={false}
            value={redirects}
            onChange={(event) => setRedirects(event.target.value)}
          />
        </Field>
        <Field
          label="Post-logout URLs"
          hint="Optional. One exact URL per line, on the same origin; up to 10."
        >
          <textarea
            rows={2}
            spellCheck={false}
            value={logouts}
            onChange={(event) => setLogouts(event.target.value)}
          />
        </Field>
        <fieldset className="applications-permission-picker">
          <legend>
            Required permissions<span aria-hidden="true"> *</span>
          </legend>
          <p>Members must have every selected permission to sign in.</p>
          <Notice message={permissionsError} />
          {permissionsLoading ? (
            <Loading />
          ) : (
            <>
              <label className="applications-search">
                <Search size={17} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Filter application permissions"
                  placeholder="Filter permissions…"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </label>
              <div className="applications-checkbox-list">
                {visible.map((permission) => (
                  <label
                    className="applications-permission-checkbox cursor-pointer"
                    key={permission.name}
                  >
                    <input
                      className="cursor-pointer"
                      type="checkbox"
                      checked={required.includes(permission.name)}
                      onChange={(event) =>
                        setRequired(
                          event.target.checked
                            ? [...required, permission.name]
                            : required.filter(
                                (name) => name !== permission.name,
                              ),
                        )
                      }
                    />
                    <span>
                      <code>{permission.name}</code>
                      <span>{permission.description}</span>
                    </span>
                  </label>
                ))}
                {!visible.length ? (
                  <p className="applications-no-results">
                    {permissions.length
                      ? "No permissions match this filter."
                      : "Declare an application permission in Permissions before creating an application."}
                  </p>
                ) : null}
              </div>
              <span className="applications-selection-count">
                {required.length} selected · all required
              </span>
            </>
          )}
        </fieldset>
        <label className="applications-enabled cursor-pointer">
          <input
            className="cursor-pointer"
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>
            <strong>Application enabled</strong>
            <span>Allow this application to request sign-in.</span>
          </span>
        </label>
        <div className="form-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={task.busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              task.busy ||
              permissionsLoading ||
              Boolean(permissionsError) ||
              !required.length
            }
          >
            {application ? "Save application" : "Create application"}
            <ArrowRight size={16} />
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ApplicationDetails({
  application,
  issuer,
  discoveryUrl,
  onClose,
  onRotate,
}: {
  application: Application;
  issuer: string;
  discoveryUrl: string;
  onClose: () => void;
  onRotate?: () => void;
}) {
  const { api } = useAuth();
  const task = useTask();
  const [currentSecret, setCurrentSecret] = useState<string>();
  const reveal = () =>
    void task.execute("", async () => {
      const result = await api<{
        clientId: string;
        clientSecret: string;
        version: string;
      }>(applicationUrl(application.clientId) + "/secret/reveal", {
        method: "POST",
        body: JSON.stringify({ version: application.version }),
      });
      setCurrentSecret(result.clientSecret);
    });
  return (
    <Dialog title="Application setup details" onClose={onClose}>
      <div className="applications-setup-heading">
        <span className="applications-icon" aria-hidden="true">
          {application.kind === "confidential" ? (
            <Server size={24} />
          ) : (
            <Globe2 size={24} />
          )}
        </span>
        <div>
          <h3>{application.name}</h3>
          <p>
            {application.kind === "confidential"
              ? "Backend application · confidential client"
              : "Browser application · public client"}
          </p>
        </div>
        <Badge tone={application.enabled ? "success" : "neutral"}>
          {application.enabled ? "Enabled" : "Disabled"}
        </Badge>
      </div>
      <section
        className="applications-credentials"
        aria-label="Application credentials"
      >
        <ReadOnlyValue label="Client ID" value={application.clientId} />
        {application.kind === "confidential" ? (
          <>
            {task.feedback}
            {currentSecret ? (
              <ReadOnlyValue
                label="Client secret"
                value={currentSecret}
                multiline
              />
            ) : (
              <Field
                label="Client secret"
                hint="Show the current secret to copy it, or rotate it to replace it."
              >
                <input
                  type="password"
                  readOnly
                  value=""
                  placeholder="••••••••••••••••"
                  autoComplete="off"
                />
              </Field>
            )}
            <div className="applications-credential-actions">
              <Button
                variant="secondary"
                disabled={task.busy}
                onClick={
                  currentSecret ? () => setCurrentSecret(undefined) : reveal
                }
              >
                {currentSecret ? <EyeOff size={17} /> : <Eye size={17} />}
                {currentSecret ? "Hide secret" : "Show secret"}
              </Button>
              {onRotate ? (
                <Button disabled={task.busy} onClick={onRotate}>
                  <KeyRound size={17} /> Rotate secret
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <p className="applications-type-note">
            This browser application uses PKCE and has no client secret.
          </p>
        )}
      </section>
      <div className="applications-setup-values">
        <ReadOnlyValue label="Issuer URL" value={issuer} />
        <ReadOnlyValue label="Discovery URL" value={discoveryUrl} />
        <ReadOnlyValue label="Application origin" value={application.origin} />
        <ReadOnlyValue
          label="Redirect URLs"
          value={application.redirectUris.join("\n")}
          multiline
        />
        {application.postLogoutRedirectUris.length ? (
          <ReadOnlyValue
            label="Post-logout URLs"
            value={application.postLogoutRedirectUris.join("\n")}
            multiline
          />
        ) : null}
      </div>
      <div className="applications-setup-protocol">
        <strong>Authorization Code + PKCE S256</strong>
        <p>
          Use the discovery document to configure your OIDC library. Request{" "}
          <code>openid profile email</code> and register these exact callbacks.
        </p>
        <p>
          {application.kind === "public"
            ? "This public application has no client secret. Do not embed a secret in browser code."
            : "Keep the client secret on the backend. Use Show secret above to view its current value; rotating replaces it."}
        </p>
      </div>
      <p className="applications-setup-permissions">
        Required permissions:{" "}
        {application.requiredPermissions.map((permission) => (
          <code key={permission}>{permission}</code>
        ))}
      </p>
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

function RotateSecret({
  application,
  onClose,
  onRotated,
}: {
  application: Application;
  onClose: () => void;
  onRotated: (result: SecretResult) => void;
}) {
  const { api } = useAuth();
  const task = useTask();
  return (
    <Dialog
      title="Rotate client secret"
      onClose={() => {
        if (!task.busy) onClose();
      }}
    >
      {task.feedback}
      <div className="applications-rotation">
        <KeyRound size={28} aria-hidden="true" />
        <strong>{application.name}</strong>
        <code>{application.clientId}</code>
        <p>
          The current secret will be replaced. Update the application's backend
          with the new secret before its next token request.
        </p>
      </div>
      <div className="form-actions">
        <Button variant="secondary" disabled={task.busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={task.busy}
          onClick={() =>
            void task.execute("", async () => {
              const result = await api<SecretResult>(
                applicationUrl(application.clientId) + "/secret",
                {
                  method: "POST",
                  body: JSON.stringify({ version: application.version }),
                },
              );
              onRotated(result);
            })
          }
        >
          Rotate secret
        </Button>
      </div>
    </Dialog>
  );
}

function DeleteApplication({
  application,
  onClose,
  onDeleted,
}: {
  application: Application;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { api } = useAuth();
  const task = useTask();
  return (
    <Dialog
      title="Delete application"
      onClose={() => {
        if (!task.busy) onClose();
      }}
    >
      {task.feedback}
      <div className="applications-rotation">
        <Trash2 size={28} aria-hidden="true" />
        <strong>{application.name}</strong>
        <code>{application.clientId}</code>
        <p>
          This permanently deletes the application’s OIDC client and
          credentials. Sign-in and token renewal will stop. Users and roles are
          kept.
        </p>
        <p>
          Access tokens already accepted by a service may remain valid until
          they expire.
        </p>
      </div>
      <div className="form-actions">
        <Button variant="secondary" disabled={task.busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={task.busy}
          onClick={() =>
            void task.execute("", async () => {
              await api(applicationUrl(application.clientId), {
                method: "DELETE",
                body: JSON.stringify({ version: application.version }),
              });
              onDeleted();
            })
          }
        >
          <Trash2 size={17} /> Delete application
        </Button>
      </div>
    </Dialog>
  );
}
