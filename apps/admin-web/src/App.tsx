import { useEffect, useState, type FormEvent } from "react";
import { ApplicationsPage } from "./ApplicationsPage";
import {
  DeleteCatalogueEntry,
  PermissionsPage,
  type Catalogue,
  type Current as CatalogueSnapshot,
} from "./AccessManagement";
import {
  Users,
  MailPlus,
  ShieldCheck,
  ScrollText,
  Plus,
  Search,
  ArrowLeft,
  Fingerprint,
  Monitor,
  Trash2,
  RefreshCw,
  KeyRound,
  Undo2,
  Settings,
  Globe2,
  Ban,
  ChevronDown,
} from "lucide-react";
import {
  useAuth,
  useResource,
  config,
  Shell,
  SignIn,
  Panel,
  Button,
  Field,
  Badge,
  Loading,
  Notice,
  Empty,
  Dialog,
  useTask,
  date,
} from "@scoretech/ui";
interface Person {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
  emailVerified: boolean;
  createdTimestamp?: number;
}
interface Role {
  name: string;
  description: string;
  permissions: string[];
}
interface Current extends CatalogueSnapshot {
  environment: string;
  revision: string;
  defaultRoleAccessPermissions?: string[];
  defaultRoleOptions?: string[];
}
interface Invitation {
  id: string;
  name: string;
  roles: string[];
  limit: number;
  completed: number;
  available: number;
  expiresAt?: number;
  state: string;
  version: number;
}
const renderRoleLabel = (role: { name: string; description?: string }) =>
  role.name === "administrador" ? "Admin" : role.description || role.name;
const items = [
  { id: "users", label: "Users", icon: <Users /> },
  { id: "invitations", label: "Invitations", icon: <MailPlus /> },
  { id: "roles", label: "Roles", icon: <ShieldCheck /> },
  { id: "permissions", label: "Permissions", icon: <KeyRound /> },
  { id: "applications", label: "Applications", icon: <Globe2 /> },
  { id: "events", label: "Security events", icon: <ScrollText /> },
];
const resolveSection = () => {
  if (location.hash === "#access-rules") return "applications";
  return items.some((item) => item.id === location.hash.slice(1))
    ? location.hash.slice(1)
    : "users";
};
const headings: Record<string, [string, string]> = {
  applications: [
    "Connected applications.",
    "Register applications and choose the permissions their members need.",
  ],
  permissions: [
    "Permissions, made explicit.",
    "Declare the permissions that services use to protect their capabilities.",
  ],
  users: [
    "People power the ecosystem.",
    "Manage SCORE identities and the access that connects them.",
  ],
  invitations: [
    "An invitation to connect.",
    "Create controlled invitations for new SCORE members.",
  ],
  roles: [
    "The right access, by design.",
    "Define the roles that connect people to SCORE services.",
  ],
  events: [
    "A record of trust.",
    "Review sign-in activity and identity security events.",
  ],
};
export default function App() {
  const auth = useAuth();
  const [section, setSection] = useState(resolveSection);
  useEffect(() => {
    const changed = () => {
      if (location.hash === "#access-rules")
        history.replaceState(null, "", "#applications");
      setSection(resolveSection());
    };
    window.addEventListener("hashchange", changed);
    if (!auth.loading) changed();
    return () => window.removeEventListener("hashchange", changed);
  }, [auth.loading]);
  if (auth.loading)
    return (
      <main className="page">
        <Loading />
      </main>
    );
  if (!auth.user) return <SignIn />;
  if (!auth.can(`admin-web:${config.environment}:access`))
    return (
      <Shell
        title="Access is not available."
        subtitle="Your SCORETech Identity account does not have permission to enter this administration service."
        section=""
        items={[]}
        onNavigate={() => {}}
      >
        <Panel title="Ask your administrator">
          <p className="muted">
            You can still manage your personal account and sign-in methods.
          </p>
        </Panel>
      </Shell>
    );
  const [title, subtitle] = headings[section];
  return (
    <Shell
      title={title}
      subtitle={subtitle}
      section={section}
      items={items}
      onNavigate={(id) => {
        location.hash = id;
        setSection(id);
      }}
    >
      {section === "applications" ? (
        <ApplicationsPage />
      ) : section === "permissions" ? (
        <PermissionsPage />
      ) : section === "users" ? (
        <Directory />
      ) : section === "roles" ? (
        <Roles />
      ) : section === "invitations" ? (
        <Invitations />
      ) : (
        <Events />
      )}
    </Shell>
  );
}
function Directory() {
  const { can } = useAuth();
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [first, setFirst] = useState(0),
    [selected, setSelected] = useState<string>(),
    [creating, setCreating] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setFirst(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({
    first: String(first),
    max: "25",
    ...(query ? { search: query } : {}),
  });
  const resource = useResource<{ users: Person[] }>(
    config.adminApiUrl + "/users?" + params,
  );
  const summary = useResource<{
    total?: number;
    enabled?: number;
    verified?: number;
    active?: number;
    emailVerified?: number;
  }>(config.adminApiUrl + "/users/summary");
  return (
    <>
      <div className="summary-grid">
        <div className="summary-card">
          <small>Directory members</small>
          <strong>
            {summary.data?.total ?? resource.data?.users.length ?? "—"}
          </strong>
        </div>
        <div className="summary-card">
          <small>Identity provider</small>
          <strong style={{ fontSize: "1.1rem" }}>SCORETech Identity</strong>
        </div>
        <div className="summary-card">
          <small>Current environment</small>
          <strong style={{ fontSize: "1.4rem", textTransform: "capitalize" }}>
            {config.environment}
          </strong>
        </div>
      </div>
      <Panel
        title="User directory"
        description="Find a person, review their account and manage assigned roles."
        actions={
          can("identity:users:create") ? (
            <Button onClick={() => setCreating(true)}>
              <Plus size={17} />
              Add user
            </Button>
          ) : null
        }
      >
        <div className="toolbar">
          <Search size={19} className="muted" />
          <input
            className="search-input"
            aria-label="Search users"
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button
            variant="quiet"
            aria-label="Refresh directory"
            onClick={resource.reload}
          >
            <RefreshCw size={17} />
          </Button>
        </div>
        {resource.error ? (
          <Notice message={resource.error} />
        ) : resource.loading && !resource.data ? (
          <Loading />
        ) : resource.data?.users.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Status</th>
                  <th>Email</th>
                  <th>Joined</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.users.map((person) => (
                  <tr key={person.id}>
                    <td>
                      <button
                        className="cursor-pointer row-link person-cell"
                        onClick={() => setSelected(person.id)}
                      >
                        <span className="avatar">
                          {(person.firstName || person.email || "S")
                            .slice(0, 1)
                            .toUpperCase()}
                        </span>
                        <span>
                          <strong>
                            {[person.firstName, person.lastName]
                              .filter(Boolean)
                              .join(" ") || person.username}
                          </strong>
                          <small>{person.email}</small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <Badge tone={person.enabled ? "success" : "danger"}>
                        {person.enabled ? "Active" : "Disabled"}
                      </Badge>
                    </td>
                    <td>
                      <Badge
                        tone={person.emailVerified ? "neutral" : "warning"}
                      >
                        {person.emailVerified ? "Verified" : "Pending"}
                      </Badge>
                    </td>
                    <td className="muted text-small">
                      {date(person.createdTimestamp)}
                    </td>
                    <td>
                      <Button
                        variant="quiet"
                        aria-label={"Open " + person.email}
                        onClick={() => setSelected(person.id)}
                      >
                        <Settings size={18} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No people found">
            Try a different name or email address.
          </Empty>
        )}
        <div className="pagination">
          <span>
            Showing {first + 1}–{first + (resource.data?.users.length || 0)}
          </span>
          <div className="button-group">
            <Button
              variant="secondary"
              disabled={first === 0 || resource.loading}
              onClick={() => setFirst(Math.max(0, first - 25))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              disabled={
                (resource.data?.users.length || 0) < 25 || resource.loading
              }
              onClick={() => setFirst(first + 25)}
            >
              Next
            </Button>
          </div>
        </div>
      </Panel>
      {creating ? (
        <CreateUser
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            resource.reload();
            summary.reload();
          }}
        />
      ) : null}
      {selected ? (
        <UserDetails
          id={selected}
          onClose={() => setSelected(undefined)}
          onSaved={() => {
            resource.reload();
            summary.reload();
          }}
        />
      ) : null}
    </>
  );
}
function CreateUser({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api, can } = useAuth();
  const task = useTask();
  const [email, setEmail] = useState(""),
    [firstName, setFirst] = useState(""),
    [lastName, setLast] = useState("");
  return (
    <Dialog title="Add a SCORE member" onClose={onClose}>
      {task.feedback}
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void task.execute("User created.", async () => {
            const result = await api<{ setupPending: boolean }>(
              config.adminApiUrl + "/users",
              {
                method: "POST",
                body: JSON.stringify({
                  username: email,
                  email,
                  firstName,
                  lastName,
                  sendVerifyEmail: can("identity:users:send-verification"),
                }),
              },
            );
            if (result.setupPending)
              throw new Error(
                "The account was created, but setup is pending. Open it before retrying.",
              );
            onSaved();
          });
        }}
      >
        <Field label="Email address">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <div className="form-grid">
          <Field label="First name">
            <input
              required
              value={firstName}
              onChange={(e) => setFirst(e.target.value)}
            />
          </Field>
          <Field label="Last name">
            <input
              required
              value={lastName}
              onChange={(e) => setLast(e.target.value)}
            />
          </Field>
        </div>
        <p className="muted text-small">
          {can("identity:users:send-verification")
            ? "A verification email will be sent."
            : "The member verifies their email when signing in."}{" "}
          The new account has no service access until you assign its roles.
        </p>
        <div className="form-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={task.busy} type="submit">
            Create account
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function UserDetails({
  id,
  onClose,
  onSaved,
}: {
  id: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const resource = useResource<{
    user: Person;
    roles: { id: string; name: string }[];
  }>(config.adminApiUrl + "/users/" + id);
  return (
    <Dialog title="Member details" onClose={onClose}>
      {resource.error ? (
        <Notice message={resource.error} />
      ) : resource.loading && !resource.data ? (
        <Loading />
      ) : resource.data ? (
        <UserEditor
          key={id}
          id={id}
          detail={resource.data}
          onClose={onClose}
          onSaved={() => {
            resource.reload();
            onSaved();
          }}
        />
      ) : null}
    </Dialog>
  );
}
function UserEditor({
  id,
  detail,
  onClose,
  onSaved,
}: {
  id: string;
  detail: { user: Person; roles: { id: string; name: string }[] };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api, can, stepUp } = useAuth();
  const task = useTask();
  const [tab, setTab] = useState("profile"),
    [firstName, setFirst] = useState(detail.user.firstName || ""),
    [lastName, setLast] = useState(detail.user.lastName || ""),
    [email, setEmail] = useState(detail.user.email || ""),
    [roles, setRoles] = useState(detail.roles.map((role) => role.name));
  const catalogue = useResource<{ roles: { name: string }[] }>(
    config.adminApiUrl + "/roles",
  );
  const [confirm, setConfirm] = useState<"deactivate" | "delete">(),
    [phrase, setPhrase] = useState("");
  const save = (e: FormEvent) => {
    e.preventDefault();
    const changes: Record<string, string> = {};
    if (can("identity:users:update:name")) {
      if (firstName !== (detail.user.firstName || ""))
        changes.firstName = firstName;
      if (lastName !== (detail.user.lastName || ""))
        changes.lastName = lastName;
    }
    if (can("identity:users:update:email") && email !== detail.user.email)
      changes.email = email;
    if (!Object.keys(changes).length) return;
    void task.execute("Account updated.", async () => {
      await api(config.adminApiUrl + "/users/" + id, {
        method: "PATCH",
        body: JSON.stringify(changes),
      });
      onSaved();
    });
  };
  return (
    <>
      <div className="list-row-leading" style={{ marginBottom: 24 }}>
        <span className="avatar">
          {(detail.user.firstName || email || "S")[0]}
        </span>
        <div>
          <strong>
            {[detail.user.firstName, detail.user.lastName]
              .filter(Boolean)
              .join(" ")}
          </strong>
          <p className="muted text-small" style={{ margin: 0 }}>
            {detail.user.email}
          </p>
        </div>
        <Badge tone={detail.user.enabled ? "success" : "danger"}>
          {detail.user.enabled ? "Active" : "Disabled"}
        </Badge>
      </div>
      <div className="tab-list" role="tablist">
        {["profile", "roles", "security", "sessions"].map((name) => (
          <button
            className="cursor-pointer"
            role="tab"
            key={name}
            aria-selected={tab === name}
            onClick={() => setTab(name)}
          >
            {name[0].toUpperCase() + name.slice(1)}
          </button>
        ))}
      </div>
      {task.feedback}
      {tab === "profile" ? (
        <>
          <form className="form" onSubmit={save}>
            <div className="form-grid">
              <Field label="First name">
                <input
                  required
                  readOnly={!can("identity:users:update:name")}
                  value={firstName}
                  onChange={(e) => setFirst(e.target.value)}
                />
              </Field>
              <Field label="Last name">
                <input
                  readOnly={!can("identity:users:update:name")}
                  value={lastName}
                  onChange={(e) => setLast(e.target.value)}
                />
              </Field>
            </div>
            <Field
              label="Email address"
              hint="Changing email requires the member to verify it again."
            >
              <input
                type="email"
                required
                readOnly={!can("identity:users:update:email")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <div className="form-actions">
              {can("identity:users:send-verification") ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void task.execute("Verification email sent.", () =>
                      api(
                        config.adminApiUrl +
                          "/users/" +
                          id +
                          "/send-verification",
                        { method: "POST" },
                      ),
                    )
                  }
                >
                  Send verification
                </Button>
              ) : null}
              {can("identity:users:update:name") ||
              can("identity:users:update:email") ? (
                <Button type="submit" disabled={task.busy}>
                  Save profile
                </Button>
              ) : null}
            </div>
          </form>
          <div className="form-actions">
            {detail.user.enabled ? (
              can("identity:users:deactivate") ? (
                <Button
                  variant="danger"
                  onClick={() => setConfirm("deactivate")}
                >
                  Disable account
                </Button>
              ) : null
            ) : can("identity:users:activate") ? (
              <Button
                variant="secondary"
                onClick={() =>
                  void task.execute("Account enabled.", async () => {
                    await api(config.adminApiUrl + "/users/" + id, {
                      method: "PATCH",
                      body: JSON.stringify({ enabled: true }),
                    });
                    onSaved();
                  })
                }
              >
                Enable account
              </Button>
            ) : null}
            {can("identity:users:delete") ? (
              <Button variant="danger" onClick={() => setConfirm("delete")}>
                Delete account
              </Button>
            ) : null}
          </div>
        </>
      ) : tab === "roles" ? (
        <>
          <p className="muted text-small">
            Select roles from the active catalogue. Unavailable definitions
            cannot be assigned.
          </p>
          {catalogue.error ? <Notice message={catalogue.error} /> : null}
          <div className="check-list">
            {catalogue.data?.roles.map((role) => (
              <label className="cursor-pointer" key={role.name}>
                <input
                  className="cursor-pointer"
                  type="checkbox"
                  checked={roles.includes(role.name)}
                  onChange={(e) =>
                    setRoles(
                      e.target.checked
                        ? [...roles, role.name]
                        : roles.filter((name) => name !== role.name),
                    )
                  }
                />
                {role.name === "administrador" ? "Admin" : role.name}
              </label>
            ))}
          </div>
          <div className="form-actions">
            <Button
              disabled={task.busy || !can("identity:users:update:roles")}
              onClick={() =>
                void task.execute(
                  "Roles updated. New access takes effect when tokens are renewed.",
                  async () => {
                    await api(config.adminApiUrl + "/users/" + id + "/roles", {
                      method: "PUT",
                      body: JSON.stringify({
                        roles: roles.filter((name) =>
                          catalogue.data?.roles.some(
                            (role) => role.name === name,
                          ),
                        ),
                      }),
                    });
                    onSaved();
                  },
                )
              }
            >
              Save roles
            </Button>
          </div>
        </>
      ) : tab === "security" ? (
        <UserSecurity id={id} />
      ) : (
        <UserSessions id={id} />
      )}{" "}
      {confirm ? (
        <Dialog
          title={
            confirm === "delete"
              ? "Delete this account?"
              : "Disable this account?"
          }
          onClose={() => {
            setConfirm(undefined);
            setPhrase("");
          }}
        >
          <p>
            {confirm === "delete"
              ? "This permanently removes this identity."
              : "The member will lose access and their active sessions will be ended."}{" "}
            Enter <strong>{detail.user.email}</strong> to confirm.
          </p>
          <Field label="Account email">
            <input value={phrase} onChange={(e) => setPhrase(e.target.value)} />
          </Field>
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setConfirm(undefined)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={task.busy || phrase !== detail.user.email}
              onClick={() =>
                void task.execute("Account updated.", async () => {
                  if (confirm === "deactivate") {
                    await stepUp(`user:${id}:deactivate`);
                    await api(config.adminApiUrl + "/users/" + id, {
                      method: "PATCH",
                      body: JSON.stringify({ enabled: false }),
                    });
                  } else
                    await api(config.adminApiUrl + "/users/" + id, {
                      method: "DELETE",
                    });
                  onSaved();
                  onClose();
                })
              }
            >
              {confirm === "delete" ? "Delete account" : "Verify and disable"}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
function UserSecurity({ id }: { id: string }) {
  const { api, can, stepUp } = useAuth();
  const task = useTask();
  const credentials = useResource<{
    credentials: {
      id: string;
      type: string;
      userLabel?: string;
      createdDate?: number;
    }[];
  }>(config.adminApiUrl + "/users/" + id + "/credentials");
  const recovery = useResource<{
    recovery?: { id: string; state: string; expiresAt: number } | null;
  }>(config.adminApiUrl + "/users/" + id + "/recovery");
  const [reason, setReason] = useState(""),
    [link, setLink] = useState(""),
    [identityVerified, setIdentityVerified] = useState(false);
  return (
    <>
      {task.feedback}
      <p className="muted text-small">
        Credential changes and recovery are verified with your administrative
        passkey.
      </p>
      {credentials.error ? <Notice message={credentials.error} /> : null}
      {credentials.data?.credentials.map((c) => (
        <div className="list-row" key={c.id}>
          <div>
            <strong>
              {c.userLabel ||
                (c.type === "otp" ? "Authenticator app" : "Passkey")}
            </strong>
            <p className="muted text-small">{date(c.createdDate)}</p>
          </div>
          {can("identity:users:credentials:delete") ? (
            <Button
              variant="danger"
              disabled={task.busy || reason.trim().length < 10}
              onClick={() =>
                void task.execute("Sign-in method removed.", async () => {
                  await stepUp(`user:${id}:credentials`);
                  await api(
                    config.adminApiUrl +
                      "/users/" +
                      id +
                      "/credentials/" +
                      encodeURIComponent(c.id),
                    { method: "DELETE", body: JSON.stringify({ reason }) },
                  );
                  credentials.reload();
                })
              }
            >
              <Trash2 size={15} />
              Remove
            </Button>
          ) : null}
        </div>
      ))}
      <Field
        label="Reason for a security action"
        hint="At least 10 characters. Record how the member's identity was verified."
      >
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
        />
      </Field>
      {can("identity:users:recovery:create") ? (
        <div className="form-actions">
          <label className="cursor-pointer text-small">
            <input
              className="cursor-pointer"
              type="checkbox"
              checked={identityVerified}
              onChange={(e) => setIdentityVerified(e.target.checked)}
            />{" "}
            I have verified this member’s identity.
          </label>
          <Button
            disabled={
              task.busy || reason.trim().length < 10 || !identityVerified
            }
            onClick={() =>
              void task.execute(
                "Recovery link created. Share it only with the verified member.",
                async () => {
                  await stepUp(`user:${id}:credentials`);
                  const draft = await api<{ id: string }>(
                    config.adminApiUrl + "/users/" + id + "/recovery/prepare",
                    { method: "POST" },
                  );
                  const created = await api<{
                    link?: string;
                    url?: string;
                    recovery?: { link?: string };
                  }>(config.adminApiUrl + "/users/" + id + "/recovery", {
                    method: "POST",
                    body: JSON.stringify({
                      reason,
                      draftId: draft.id,
                      identityVerified: true,
                    }),
                  });
                  setLink(
                    created.link || created.url || created.recovery?.link || "",
                  );
                  recovery.reload();
                },
              )
            }
          >
            <KeyRound size={16} />
            Create recovery link
          </Button>
        </div>
      ) : null}
      {link ? (
        <div className="code-box" role="status">
          {link}
        </div>
      ) : null}
      {recovery.error ? (
        <p className="muted text-small">
          Recovery status is unavailable or your role cannot view it.
        </p>
      ) : recovery.data?.recovery ? (
        <div className="list-row">
          <span>
            Recovery: {recovery.data.recovery.state} ·{" "}
            {date(recovery.data.recovery.expiresAt)}
          </span>
          {can("identity:users:recovery:revoke") ? (
            <Button
              variant="danger"
              disabled={task.busy}
              onClick={() =>
                void task.execute("Recovery revoked.", async () => {
                  await stepUp(`user:${id}:credentials`);
                  await api(
                    config.adminApiUrl +
                      "/users/" +
                      id +
                      "/recovery/" +
                      recovery.data!.recovery!.id,
                    { method: "DELETE" },
                  );
                  setLink("");
                  recovery.reload();
                })
              }
            >
              Revoke
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
function UserSessions({ id }: { id: string }) {
  const { api, can } = useAuth();
  const task = useTask();
  const resource = useResource<{
    sessions: { id: string; ipAddress: string; lastAccess: number }[];
  }>(config.adminApiUrl + "/users/" + id + "/sessions");
  return (
    <>
      {task.feedback}
      {resource.error ? <Notice message={resource.error} /> : null}
      {resource.data?.sessions.length ? (
        resource.data.sessions.map((session) => (
          <div className="list-row" key={session.id}>
            <div className="list-row-leading">
              <Monitor size={22} />
              <div>
                <strong>{session.ipAddress}</strong>
                <p className="muted text-small">
                  Last active {date(session.lastAccess)}
                </p>
              </div>
            </div>
            {can("identity:users:logout") ? (
              <Button
                variant="secondary"
                disabled={task.busy}
                onClick={() =>
                  void task.execute("Session ended.", async () => {
                    await api(
                      config.adminApiUrl +
                        "/users/" +
                        id +
                        "/sessions/" +
                        encodeURIComponent(session.id),
                      { method: "DELETE" },
                    );
                    resource.reload();
                  })
                }
              >
                End session
              </Button>
            ) : null}
          </div>
        ))
      ) : (
        <Empty title="No active sessions" />
      )}
    </>
  );
}
function localDateTime(value: number) {
  return new Date(value - new Date(value).getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function Invitations() {
  const { api, can } = useAuth();
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [first, setFirst] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setFirst(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({
    first: String(first),
    max: "25",
    ...(query ? { search: query } : {}),
  });
  const resource = useResource<{ invitations: Invitation[] }>(
    config.adminApiUrl + "/invitations?" + params,
  );
  const reload = () => {
    if (first > 0 && resource.data?.invitations.length === 1)
      setFirst(first - 25);
    else resource.reload();
  };
  const catalogue = useResource<{ roles: { name: string }[] }>(
    config.adminApiUrl + "/roles",
  );
  const task = useTask();
  const [create, setCreate] = useState(false),
    [name, setName] = useState(""),
    [roles, setRoles] = useState<string[]>(["member"]),
    [limit, setLimit] = useState(1),
    [expires, setExpires] = useState(""),
    [link, setLink] = useState(""),
    [linkInvitationId, setLinkInvitationId] = useState(""),
    [editing, setEditing] = useState<Invitation>();
  const [confirm, setConfirm] = useState<{
    invitation: Invitation;
    action: "revoke" | "delete";
  }>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void task.execute(
      editing ? "Invitation updated." : "Invitation created.",
      async () => {
        if (editing)
          await api(config.adminApiUrl + "/invitations/" + editing.id, {
            method: "PATCH",
            body: JSON.stringify({
              name,
              limit,
              expiresAt: expires
                ? editing?.expiresAt &&
                  expires === localDateTime(editing.expiresAt)
                  ? editing.expiresAt
                  : new Date(expires).getTime()
                : null,
              version: editing.version,
            }),
          });
        else {
          const value = await api<{ link: string; invitation: { id: string } }>(
            config.adminApiUrl + "/invitations",
            {
              method: "POST",
              body: JSON.stringify({
                name,
                roles,
                limit,
                expiresAt: expires ? new Date(expires).getTime() : null,
              }),
            },
          );
          setLink(value.link);
          setLinkInvitationId(value.invitation.id);
        }
        resource.reload();
        setCreate(false);
        setEditing(undefined);
      },
    );
  };
  return (
    <>
      {task.feedback}
      {link ? (
        <Panel
          title="Invitation link"
          description="Copy this link now. It is not included in later invitation listings."
        >
          <div className="code-box">{link}</div>
          <Button
            variant="quiet"
            onClick={() => void navigator.clipboard.writeText(link)}
          >
            Copy link
          </Button>
        </Panel>
      ) : null}
      <Panel
        title="Invitations"
        description="New members receive only the roles selected for their invitation."
        actions={
          can("identity:invitations:create") ? (
            <Button
              onClick={() => {
                setEditing(undefined);
                setName("");
                setLimit(1);
                setExpires("");
                setRoles(["member"]);
                setCreate(true);
              }}
            >
              <Plus size={17} />
              Create invitation
            </Button>
          ) : null
        }
      >
        <div className="toolbar">
          <Search size={19} className="muted" />
          <input
            className="search-input"
            aria-label="Search invitations"
            placeholder="Search by name or role…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button
            variant="quiet"
            aria-label="Refresh invitations"
            onClick={resource.reload}
          >
            <RefreshCw size={17} />
          </Button>
        </div>
        {resource.error ? (
          <Notice message={resource.error} />
        ) : resource.loading && !resource.data ? (
          <Loading />
        ) : resource.data?.invitations.length ? (
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Invitations table"
          >
            <table aria-label="Invitations">
              <thead>
                <tr>
                  <th scope="col">Invitation</th>
                  <th scope="col">Status</th>
                  <th scope="col">Registrations</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.invitations.map((invite) => (
                  <tr key={invite.id}>
                    <td>
                      <div className="person-cell">
                        <MailPlus size={20} aria-hidden="true" />
                        <div>
                          <strong>{invite.name}</strong>
                          <small>
                            {invite.roles.map((role) => (
                              <span className="role-chip" key={role}>
                                {role === "administrador" ? "Admin" : role}
                              </span>
                            ))}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge
                        tone={invite.state === "active" ? "success" : "neutral"}
                      >
                        {invite.state}
                      </Badge>
                    </td>
                    <td>
                      {invite.completed} of {invite.limit} used
                    </td>
                    <td>
                      <span className="muted text-small">
                        {invite.expiresAt
                          ? date(invite.expiresAt)
                          : "No expiry"}
                      </span>
                    </td>
                    <td>
                      <div className="button-group">
                        {can("identity:invitations:update") ? (
                          <Button
                            variant="quiet"
                            aria-label={"Edit invitation " + invite.name}
                            title="Edit invitation"
                            disabled={task.busy}
                            onClick={() => {
                              setEditing(invite);
                              setName(invite.name);
                              setLimit(invite.limit);
                              setExpires(
                                invite.expiresAt
                                  ? localDateTime(invite.expiresAt)
                                  : "",
                              );
                              setCreate(true);
                            }}
                          >
                            <Settings size={17} />
                          </Button>
                        ) : null}
                        {can("identity:invitations:revoke") &&
                        invite.state === "active" ? (
                          <Button
                            variant="quiet"
                            className="catalogue-delete-action"
                            aria-label={"Revoke invitation " + invite.name}
                            title="Revoke invitation"
                            disabled={task.busy}
                            onClick={() =>
                              setConfirm({
                                invitation: invite,
                                action: "revoke",
                              })
                            }
                          >
                            <Ban size={17} />
                          </Button>
                        ) : null}
                        {can("identity:invitations:delete") &&
                        ["revoked", "expired"].includes(invite.state) ? (
                          <Button
                            variant="quiet"
                            className="catalogue-delete-action"
                            aria-label={"Delete invitation " + invite.name}
                            title="Delete invitation"
                            disabled={task.busy}
                            onClick={() =>
                              setConfirm({
                                invitation: invite,
                                action: "delete",
                              })
                            }
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
        ) : (
          <Empty title={query ? "No invitations found" : "No invitations yet"}>
            {query
              ? "Try a different name or role."
              : "Create an invitation to welcome a new member."}
          </Empty>
        )}
        <div className="pagination">
          <span>
            Showing {resource.data?.invitations.length ? first + 1 : 0}–
            {resource.data?.invitations.length
              ? first + resource.data.invitations.length
              : 0}
          </span>
          <div className="button-group">
            <Button
              variant="secondary"
              disabled={
                first === 0 || resource.loading || search.trim() !== query
              }
              onClick={() => setFirst(Math.max(0, first - 25))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              disabled={
                (resource.data?.invitations.length || 0) < 25 ||
                resource.loading ||
                search.trim() !== query
              }
              onClick={() => setFirst(first + 25)}
            >
              Next
            </Button>
          </div>
        </div>
      </Panel>
      {confirm ? (
        <InvitationConfirmation
          invitation={confirm.invitation}
          action={confirm.action}
          onClose={() => setConfirm(undefined)}
          onConfirmed={() => {
            if (confirm.invitation.id === linkInvitationId) setLink("");
            setConfirm(undefined);
            if (confirm.action === "delete") reload();
            else resource.reload();
          }}
        />
      ) : null}
      {create ? (
        <Dialog
          title={editing ? "Edit invitation" : "Create invitation"}
          onClose={() => setCreate(false)}
        >
          <form onSubmit={submit} className="form">
            <Field label="Invitation name">
              <input
                required
                maxLength={150}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <div className="form-grid">
              <Field label="Maximum registrations">
                <input
                  required
                  type="number"
                  min={editing?.completed || 1}
                  max={100000}
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                />
              </Field>
              <Field label="Expires at (optional)">
                <input
                  type="datetime-local"
                  value={expires}
                  onChange={(e) => setExpires(e.target.value)}
                />
              </Field>
            </div>
            {!editing ? (
              <div>
                <p className="text-small">Roles granted to new members</p>
                <div className="check-list">
                  {catalogue.data?.roles.map((role) => (
                    <label className="cursor-pointer" key={role.name}>
                      <input
                        className="cursor-pointer"
                        type="checkbox"
                        checked={roles.includes(role.name)}
                        onChange={(e) =>
                          setRoles(
                            e.target.checked
                              ? [...roles, role.name]
                              : roles.filter((r) => r !== role.name),
                          )
                        }
                      />
                      {role.name === "administrador" ? "Admin" : role.name}
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="form-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setCreate(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={task.busy || (!editing && !roles.length)}
              >
                {editing ? "Save changes" : "Create invitation"}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}
function InvitationConfirmation({
  invitation,
  action,
  onClose,
  onConfirmed,
}: {
  invitation: Invitation;
  action: "revoke" | "delete";
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const { api } = useAuth();
  const task = useTask();
  const label = action === "revoke" ? "Revoke invitation" : "Delete invitation";
  return (
    <Dialog
      title={label}
      onClose={() => {
        if (!task.busy) onClose();
      }}
    >
      {task.feedback}
      <div className="form">
        <strong>{invitation.name}</strong>
        <p>
          {action === "revoke"
            ? "This invitation link will stop accepting new registrations. Members who already joined keep their accounts and roles."
            : "This permanently removes the revoked or expired invitation. Existing member accounts, role grants and registration audit records are kept."}
        </p>
        <div className="form-actions">
          <Button variant="secondary" disabled={task.busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={task.busy}
            onClick={() =>
              void task.execute("", async () => {
                await api(
                  config.adminApiUrl +
                    "/invitations/" +
                    invitation.id +
                    (action === "revoke" ? "/revoke" : ""),
                  { method: action === "revoke" ? "POST" : "DELETE" },
                );
                onConfirmed();
              })
            }
          >
            {action === "revoke" ? <Ban size={17} /> : <Trash2 size={17} />}{" "}
            {label}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
function Roles() {
  const { api, can } = useAuth();
  const [search, setSearch] = useState(""),
    [first, setFirst] = useState(0);
  const current = useResource<Current>(
    config.adminApiUrl + "/catalogue?environment=" + config.environment,
  );
  const status = useResource<{
    environments: {
      state: string;
      desiredRevision?: string;
      observedRevision?: string;
      detail: string;
    }[];
  }>(config.adminApiUrl + "/catalogue/environments");
  const history = useResource<{
    revisions: {
      id: string;
      type: string;
      reason: string;
      createdAt: string;
      actor: string;
    }[];
  }>(config.adminApiUrl + "/catalogue/revisions");
  const task = useTask();
  const [deleting, setDeleting] = useState<Role>();
  const [changingDefault, setChangingDefault] = useState(false);
  const [editing, setEditing] = useState<Role | null | undefined>(),
    [reason, setReason] = useState("");
  useEffect(() => {
    const timer = setInterval(status.reload, 4000);
    return () => clearInterval(timer);
  }, [status.reload]);
  const refresh = () => {
    current.reload();
    status.reload();
    history.reload();
  };
  const publish = (catalogue: Catalogue, changeReason = reason) =>
    task.execute("Roles saved. Changes are active.", async () => {
      await api(config.adminApiUrl + "/catalogue/revisions", {
        method: "POST",
        body: JSON.stringify({
          baseSha: current.data!.baseSha,
          catalogue,
          reason: changeReason,
          environments: [config.environment],
          sourceEnvironment: config.environment,
        }),
      });
      setEditing(undefined);
      setChangingDefault(false);
      setReason("");
      refresh();
    });
  const query = search.trim().toLowerCase();
  const roles =
    current.data?.catalogue.roles.filter((role) =>
      `${role.name} ${renderRoleLabel(role)}`.toLowerCase().includes(query),
    ) ?? [];
  const offset = Math.min(
    first,
    Math.max(0, Math.ceil(roles.length / 25) - 1) * 25,
  );
  const pageRoles = roles.slice(offset, offset + 25);
  const state = status.data?.environments?.[0];
  return (
    <>
      {task.feedback}
      {status.error ? (
        <Notice message={status.error} />
      ) : state && state.state !== "applied" ? (
        <Notice
          tone={state.state === "failed" ? "error" : "info"}
          message={state.detail || "Waiting for the catalogue to be applied."}
        />
      ) : null}
      <Panel
        title="Roles"
        description="A role groups service access and operation permissions. People inherit access through their assigned roles."
        actions={
          can("identity:roles:manage") ? (
            <div className="button-group">
              {current.data?.capabilities?.managePermissions ? (
                <Button
                  variant="secondary"
                  disabled={task.busy || current.loading}
                  onClick={() => setChangingDefault(true)}
                >
                  Change default role
                </Button>
              ) : null}
              <Button onClick={() => setEditing(null)}>
                <Plus size={17} />
                Create role
              </Button>
            </div>
          ) : null
        }
      >
        <div className="toolbar">
          <Search size={19} className="muted" />
          <input
            className="search-input"
            aria-label="Search roles"
            placeholder="Search by name or description…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setFirst(0);
            }}
          />
          <Button variant="quiet" aria-label="Refresh roles" onClick={refresh}>
            <RefreshCw size={17} />
          </Button>
        </div>
        {current.error ? (
          <Notice message={current.error} />
        ) : current.loading && !current.data ? (
          <Loading />
        ) : !roles.length ? (
          <Empty title="No roles found">
            Try a different name or description.
          </Empty>
        ) : (
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Roles table"
          >
            <table aria-label="Role catalogue">
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">Permissions</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageRoles.map((role) => (
                  <tr key={role.name}>
                    <td>
                      <div className="person-cell">
                        <ShieldCheck size={20} aria-hidden="true" />
                        <div>
                          <strong>{renderRoleLabel(role)}</strong>
                          <small>
                            <code>{role.name}</code>{" "}
                            {role.name === "administrador" ? (
                              <Badge>Protected</Badge>
                            ) : role.name ===
                              current.data?.catalogue.defaultRole ? (
                              <Badge>Default for new users</Badge>
                            ) : null}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="person-cell">
                        <div>
                          <strong>
                            {role.permissions.length}{" "}
                            {role.permissions.length === 1
                              ? "permission"
                              : "permissions"}
                          </strong>
                          <small>
                            {
                              role.permissions.filter((permission) =>
                                permission.endsWith(":access"),
                              ).length
                            }{" "}
                            service access grants
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="button-group">
                        <Button
                          variant="quiet"
                          aria-label="Edit role"
                          title="Edit role"
                          disabled={
                            !can("identity:roles:manage") ||
                            role.name === "administrador"
                          }
                          onClick={() => setEditing(role)}
                        >
                          <Settings size={17} />
                        </Button>
                        {can("identity:roles:manage") ? (
                          <Button
                            variant="quiet"
                            className="catalogue-delete-action"
                            aria-label={"Delete role " + role.name}
                            title={
                              role.name === "administrador" ||
                              role.name === "member" ||
                              role.name ===
                                (current.data?.catalogue.defaultRole ??
                                  "member")
                                ? "Built-in role is protected"
                                : "Delete role"
                            }
                            disabled={
                              task.busy ||
                              role.name === "administrador" ||
                              role.name === "member" ||
                              role.name ===
                                (current.data?.catalogue.defaultRole ??
                                  "member")
                            }
                            onClick={() => setDeleting(role)}
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
        )}
        <div className="pagination">
          <span>
            Showing {roles.length ? offset + 1 : 0}–{offset + pageRoles.length}
          </span>
          <div className="button-group">
            <Button
              variant="secondary"
              disabled={offset === 0}
              onClick={() => setFirst(Math.max(0, offset - 25))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              disabled={offset + 25 >= roles.length}
              onClick={() => setFirst(offset + 25)}
            >
              Next
            </Button>
          </div>
        </div>
      </Panel>
      <details className="panel role-revision-history">
        <summary className="cursor-pointer">
          <h2>Revision history</h2>
          <ChevronDown size={20} aria-hidden="true" />
        </summary>
        <p className="role-revision-description">
          Every catalogue change records its author and reason. Restoration
          creates a new revision.
        </p>
        {history.error ? (
          <Notice message={history.error} />
        ) : history.data?.revisions.length ? (
          history.data.revisions.map((revision) => (
            <div className="list-row" key={revision.id}>
              <div>
                <strong>{revision.reason}</strong>
                <p className="muted text-small">
                  {date(revision.createdAt)} · {revision.type}
                </p>
              </div>
              {can("identity:roles:manage") ? (
                <Button
                  variant="quiet"
                  disabled={task.busy}
                  onClick={() => {
                    const restoreReason = window.prompt(
                      "Reason for restoring this role definition (at least 8 characters)",
                    );
                    if (restoreReason && restoreReason.trim().length >= 8)
                      void task.execute(
                        "Roles restored. Changes are active.",
                        async () => {
                          await api(
                            config.adminApiUrl + "/catalogue/rollbacks",
                            {
                              method: "POST",
                              body: JSON.stringify({
                                baseSha: current.data!.baseSha,
                                operationId: revision.id,
                                reason: restoreReason,
                                environments: [config.environment],
                              }),
                            },
                          );
                          refresh();
                        },
                      );
                  }}
                >
                  <Undo2 size={15} />
                  Restore
                </Button>
              ) : null}
            </div>
          ))
        ) : (
          <Empty title="No revisions yet">
            Your first published role change will appear here.
          </Empty>
        )}
      </details>
      {deleting && current.data ? (
        <DeleteCatalogueEntry
          kind="role"
          entry={deleting}
          current={current.data}
          onClose={() => setDeleting(undefined)}
          onDeleted={() => {
            setDeleting(undefined);
            refresh();
          }}
        />
      ) : null}
      {editing !== undefined && current.data ? (
        <RoleEditor
          role={editing}
          current={current.data}
          busy={task.busy}
          error={task.error}
          reason={reason}
          setReason={setReason}
          onClose={() => setEditing(undefined)}
          onPublish={publish}
        />
      ) : null}
      {changingDefault && current.data ? (
        <DefaultRoleDialog
          current={current.data}
          busy={task.busy}
          error={task.error}
          onClose={() => setChangingDefault(false)}
          onPublish={publish}
        />
      ) : null}
    </>
  );
}
function DefaultRoleDialog({
  current,
  busy,
  error,
  onClose,
  onPublish,
}: {
  current: Current;
  busy: boolean;
  error: string;
  onClose: () => void;
  onPublish: (catalogue: Catalogue, reason: string) => Promise<boolean>;
}) {
  const previous = current.catalogue.defaultRole ?? "member";
  const [selected, setSelected] = useState(previous);
  const [reason, setReason] = useState("");
  const options = current.catalogue.roles.filter((role) =>
    current.defaultRoleOptions?.includes(role.name),
  );
  const canSave =
    !busy &&
    selected !== previous &&
    options.some(({ name }) => name === selected) &&
    reason.trim().length >= 8;
  return (
    <Dialog
      title="Change default role"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <Notice message={error} />
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave)
            void onPublish(
              { ...current.catalogue, defaultRole: selected },
              reason,
            );
        }}
      >
        <Field
          label="Default role"
          hint="New users receive this role. Existing assignments stay in place."
        >
          <select
            className="cursor-pointer"
            required
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            {options.map((role) => (
              <option key={role.name} value={role.name}>
                {renderRoleLabel(role)} ({role.name})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reason for this change">
          <textarea
            required
            minLength={8}
            maxLength={300}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <div className="form-actions">
          <Button
            type="button"
            variant="quiet"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!canSave}>
            Save default role
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function RoleEditor({
  role,
  current,
  busy,
  error,
  reason,
  setReason,
  onClose,
  onPublish,
}: {
  role: Role | null;
  current: Current;
  busy: boolean;
  error: string;
  reason: string;
  setReason: (value: string) => void;
  onClose: () => void;
  onPublish: (catalogue: Catalogue) => Promise<boolean>;
}) {
  const [name, setName] = useState(role?.name || ""),
    [description, setDescription] = useState(role?.description || ""),
    [permissions, setPermissions] = useState(role?.permissions || []),
    [preview, setPreview] = useState(false);
  const baseline = role?.name === (current.catalogue.defaultRole ?? "member");
  const added = permissions.filter((p) => !role?.permissions.includes(p)),
    removed = (role?.permissions || []).filter((p) => !permissions.includes(p));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!preview) {
      setPreview(true);
      return;
    }
    const roles = role
      ? current.catalogue.roles.map((r) =>
          r.name === role.name ? { name, description, permissions } : r,
        )
      : [...current.catalogue.roles, { name, description, permissions }];
    void onPublish({ ...current.catalogue, roles });
  };
  const groups = new Map<string, { name: string; description: string }[]>();
  for (const permission of current.catalogue.permissions) {
    if (
      baseline &&
      !current.defaultRoleAccessPermissions?.includes(permission.name)
    )
      continue;
    const key = permission.name.split(":")[0];
    groups.set(key, [...(groups.get(key) || []), permission]);
  }
  return (
    <Dialog title={role ? "Edit role" : "Create role"} onClose={onClose}>
      <Notice message={error} />
      <form onSubmit={submit} className="form">
        {preview ? (
          <>
            <Notice
              tone="info"
              message="Review how this role definition changes. Existing members keep their role assignments; access follows the applied definition when tokens renew."
            />
            <div className="code-box">
              {`Role: ${name}\n${description}\n\nAdded:\n${added.join("\n") || "None"}\n\nRemoved:\n${removed.join("\n") || "None"}`}
            </div>
            <Field label="Reason for this change">
              <textarea
                required
                minLength={8}
                maxLength={300}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <Field
              label="Role identifier"
              hint="Use lowercase letters, numbers and hyphens. The identifier stays stable after creation."
            >
              <input
                required
                pattern="[a-z][a-z0-9-]*"
                maxLength={150}
                readOnly={!!role}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Description">
              <input
                maxLength={500}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            {baseline ? (
              <Notice
                tone="info"
                message={
                  current.capabilities?.managePermissions
                    ? "Everyone with the default role receives the selected application access permissions."
                    : "Only Identity administrators can change default application access."
                }
              />
            ) : null}
            {baseline &&
            current.capabilities?.managePermissions &&
            groups.size === 0 ? (
              <p className="muted">
                Create an application access permission, such as sphere:access,
                in Permissions first.
              </p>
            ) : null}
            {groups.size > 0 ? (
              <div className="check-list">
                {Array.from(groups.entries()).map(([service, entries]) => (
                  <fieldset
                    key={service}
                    style={{ border: 0, padding: "0 0 12px" }}
                  >
                    <legend className="eyebrow">{service}</legend>
                    {entries.map((permission) => (
                      <label className="cursor-pointer" key={permission.name}>
                        <input
                          className="cursor-pointer"
                          type="checkbox"
                          checked={permissions.includes(permission.name)}
                          onChange={(e) =>
                            setPermissions(
                              e.target.checked
                                ? [...permissions, permission.name]
                                : permissions.filter(
                                    (p) => p !== permission.name,
                                  ),
                            )
                          }
                        />
                        <span>
                          {permission.name.endsWith(":access")
                            ? "Access service"
                            : permission.name}
                          <small>{permission.name}</small>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                ))}
              </div>
            ) : null}
          </>
        )}
        <div className="form-actions">
          {preview ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setPreview(false)}
            >
              Back to editing
            </Button>
          ) : null}
          <Button type="button" variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || (preview && reason.trim().length < 8)}
            type="submit"
          >
            {preview ? "Publish changes" : "Review changes"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function Events() {
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [first, setFirst] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setFirst(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({
    first: String(first),
    max: "25",
    ...(filter ? { type: filter } : {}),
    ...(query ? { search: query } : {}),
  });
  const resource = useResource<{
    events: {
      type: string;
      time: number;
      userId?: string;
      clientId?: string;
      ipAddress?: string;
      error?: string;
    }[];
  }>(config.adminApiUrl + "/security-events?" + params);
  return (
    <Panel
      title="Security events"
      description="Identity activity only. This does not track navigation within connected services."
    >
      <div className="toolbar events-toolbar">
        <Search size={19} className="muted" />
        <input
          className="search-input"
          type="search"
          aria-label="Search security events"
          placeholder="Search event, application, user ID or IP…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          className="cursor-pointer search-input"
          aria-label="Event type"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setFirst(0);
          }}
        >
          <option value="">All event types</option>
          <option value="LOGIN">Sign-ins</option>
          <option value="LOGIN_ERROR">Failed sign-ins</option>
          <option value="LOGOUT">Sign-outs</option>
          <option value="REGISTER">Registrations</option>
        </select>
        <Button
          variant="quiet"
          aria-label="Refresh security events"
          onClick={resource.reload}
        >
          <RefreshCw size={17} />
        </Button>
      </div>
      {resource.error ? (
        <Notice message={resource.error} />
      ) : resource.loading && !resource.data ? (
        <Loading />
      ) : resource.data?.events.length ? (
        <div className="table-wrap">
          <table aria-label="Security events">
            <thead>
              <tr>
                <th>Event</th>
                <th>Time</th>
                <th>Application</th>
                <th>IP address</th>
              </tr>
            </thead>
            <tbody>
              {resource.data.events.map((event, i) => (
                <tr key={i}>
                  <td>
                    <Badge tone={event.error ? "danger" : "neutral"}>
                      {event.type.replaceAll("_", " ")}
                    </Badge>
                  </td>
                  <td>{date(event.time)}</td>
                  <td className="muted">{event.clientId || "—"}</td>
                  <td className="muted">{event.ipAddress || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No security events found" />
      )}
      <div className="pagination">
        <span>
          Showing {resource.data?.events.length ? first + 1 : 0}–
          {resource.data?.events.length
            ? first + resource.data.events.length
            : 0}
        </span>
        <div className="button-group">
          <Button
            variant="secondary"
            disabled={
              first === 0 || resource.loading || search.trim() !== query
            }
            onClick={() => setFirst(Math.max(0, first - 25))}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            disabled={
              (resource.data?.events.length || 0) < 25 ||
              resource.loading ||
              search.trim() !== query
            }
            onClick={() => setFirst(first + 25)}
          >
            Next
          </Button>
        </div>
      </div>
    </Panel>
  );
}
