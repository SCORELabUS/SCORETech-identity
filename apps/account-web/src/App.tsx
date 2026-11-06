import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  UserRound,
  Fingerprint,
  Monitor,
  Palette,
  KeyRound,
  Mail,
  ShieldCheck,
  Trash2,
  ArrowRight,
  ArrowLeft,
  ChevronRight,
  Sun,
  Moon,
  Check,
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
import "./account-experience.css";
interface Profile {
  id: string;
  firstName?: string;
  lastName?: string;
  email: string;
  emailVerified: boolean;
  phone?: string;
  roles: string[];
  permissions: string[];
  avatar: { kind: string; backgroundColor?: string; foregroundColor?: string };
  capabilities?: { avatarUpload: boolean };
}
interface Credential {
  id: string;
  label: string;
  createdAt?: number;
}
interface Security {
  administrator: boolean;
  passkeys: Credential[];
  totp: Credential[];
}
interface Session {
  id: string;
  current: boolean;
  start: number;
  lastAccess: number;
  ipAddress: string;
  browser?: string;
  operatingSystem?: string;
  clients?: Record<string, string>;
}
const items = [
  { id: "profile", label: "Profile", icon: <UserRound /> },
  { id: "security", label: "Security", icon: <Fingerprint /> },
  { id: "sessions", label: "Devices and sessions", icon: <Monitor /> },
  { id: "appearance", label: "Preferences", icon: <Palette /> },
];
const descriptions: Record<string, [string, string]> = {
  profile: [
    "Your profile.",
    "The details that identify you across the SCORE ecosystem.",
  ],
  security: [
    "A secure way in.",
    "Manage the sign-in methods that protect your identity.",
  ],
  sessions: [
    "Your connected devices.",
    "Review where you are signed in and end sessions you no longer need.",
  ],
  appearance: [
    "Make it yours.",
    "A few personal touches for your SCORETech Identity account.",
  ],
};
export default function App() {
  const auth = useAuth();
  const [section, setSection] = useState(() =>
    items.some((i) => i.id === location.hash.slice(1))
      ? location.hash.slice(1)
      : "profile",
  );
  useEffect(() => {
    const changed = () =>
      setSection(
        items.some((i) => i.id === location.hash.slice(1))
          ? location.hash.slice(1)
          : "profile",
      );
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
  const [title, subtitle] = descriptions[section];
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
      {section === "profile" ? (
        <ProfilePanel />
      ) : section === "security" ? (
        <SecurityPanel />
      ) : section === "sessions" ? (
        <SessionsPanel />
      ) : (
        <PreferencesPanel />
      )}
    </Shell>
  );
}
function ProfilePanel() {
  const resource = useResource<Profile>(config.accountApiUrl + "/me");
  if (resource.loading && !resource.data) return <Loading />;
  if (resource.error) return <Notice message={resource.error} />;
  return resource.data ? (
    <ProfileForm
      key={resource.data.id}
      profile={resource.data}
      onSaved={resource.reload}
    />
  ) : null;
}
function ProfileForm({
  profile,
  onSaved,
}: {
  profile: Profile;
  onSaved: () => void;
}) {
  const { api, accountAction } = useAuth();
  const task = useTask();
  const [firstName, setFirst] = useState(profile.firstName || ""),
    [lastName, setLast] = useState(profile.lastName || ""),
    [phone, setPhone] = useState(profile.phone || "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void task.execute("Your profile has been updated.", async () => {
      await api(config.accountApiUrl + "/me", {
        method: "PATCH",
        body: JSON.stringify({
          firstName,
          lastName,
          phone,
        }),
      });
      onSaved();
    });
  };
  return (
    <>
      {task.feedback}
      <Panel
        title="Personal information"
        description="Your name and contact details are shared only with services you use."
      >
        <div className="list-row" style={{ paddingTop: 0, marginBottom: 22 }}>
          <div className="list-row-leading">
            <span className="avatar avatar-large">
              {(firstName || profile.email).slice(0, 1).toUpperCase()}
            </span>
            <div>
              <h3>
                {[firstName, lastName].filter(Boolean).join(" ") ||
                  "SCORE member"}
              </h3>
              <p>One profile for your SCORE services.</p>
            </div>
          </div>
          <Badge tone={profile.emailVerified ? "success" : "warning"}>
            {profile.emailVerified ? "Email verified" : "Verification required"}
          </Badge>
        </div>
        <form onSubmit={submit} className="form">
          <div className="form-grid">
            <Field label="First name">
              <input
                required
                autoComplete="given-name"
                maxLength={100}
                value={firstName}
                onChange={(e) => setFirst(e.target.value)}
              />
            </Field>
            <Field label="Last name">
              <input
                autoComplete="family-name"
                maxLength={100}
                value={lastName}
                onChange={(e) => setLast(e.target.value)}
              />
            </Field>
            <Field
              label="Email address"
              hint="Changing your email requires identity verification."
            >
              <input type="email" readOnly value={profile.email} />
            </Field>
            <Field
              label="Phone number"
              hint="Optional. Include your country code, for example +34612345678."
            >
              <input
                type="tel"
                autoComplete="tel"
                pattern="\+?[1-9][0-9]{6,14}"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
          </div>
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                void task.execute("", () => accountAction("UPDATE_EMAIL"))
              }
            >
              Change email <ArrowRight size={15} />
            </Button>
            <Button type="submit" disabled={task.busy}>
              Save changes
            </Button>
          </div>
        </form>
      </Panel>
      <Panel
        title="Your access"
        description="Your administrator manages the roles and service access attached to your account."
      >
        {profile.roles.length ? (
          <div>
            {profile.roles.map((role) => (
              <span key={role} className="role-chip">
                {role === "administrador" ? "Admin" : role}
              </span>
            ))}
          </div>
        ) : (
          <p className="muted text-small">
            Your account is ready. Ask your administrator to grant access to the
            services you need.
          </p>
        )}
      </Panel>
    </>
  );
}
type SecurityMethod = "passkeys" | "authenticator" | "email";
function SecurityPanel() {
  const { user, accountAction } = useAuth();
  const resource = useResource<Security>(config.accountApiUrl + "/security");
  const task = useTask();
  const [method, setMethod] = useState<SecurityMethod>();
  const [remove, setRemove] = useState<Credential>();
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const methodButtons = useRef<
    Partial<Record<SecurityMethod, HTMLButtonElement | null>>
  >({});
  const previousMethod = useRef<SecurityMethod | undefined>(undefined);
  useEffect(() => {
    if (method) detailHeading.current?.focus();
    else if (previousMethod.current)
      methodButtons.current[previousMethod.current]?.focus();
    previousMethod.current = method;
  }, [method]);
  const action = (name: string) =>
    void task.execute("", () => accountAction(name));
  const security = resource.data;
  const email =
    typeof user?.profile.email === "string" ? user.profile.email : undefined;
  const credentials =
    method === "passkeys" ? security?.passkeys : security?.totp;
  const methods = security
    ? [
        {
          id: "passkeys" as const,
          title: "Passkeys",
          icon: <Fingerprint size={27} />,
          description: "Your fingerprint, face or device security key.",
          count: `${security.passkeys.length} ${security.passkeys.length === 1 ? "passkey" : "passkeys"}`,
          status: "Recommended",
          label: "Manage passkeys",
        },
        {
          id: "authenticator" as const,
          title: "Authenticator app",
          icon: <KeyRound size={27} />,
          description: "Temporary codes from an app you trust.",
          count: `${security.totp.length} ${security.totp.length === 1 ? "app" : "apps"}`,
          status: security.totp.length ? "Configured" : "Not configured",
          label: "Manage authenticator app",
        },
        {
          id: "email" as const,
          title: "Email codes",
          icon: <Mail size={27} />,
          description: "A one-time code sent to your verified address.",
          count: "1 email address",
          status: "Available",
          label: "View email code details",
        },
      ]
    : [];
  const selected = methods.find((item) => item.id === method);
  return (
    <>
      {task.feedback}
      {resource.error ? <Notice message={resource.error} /> : null}
      {resource.loading && !security ? <Loading /> : null}
      {security ? (
        <>
          {method && selected ? (
            <section className="panel security-detail">
              <Button
                variant="quiet"
                className="security-back"
                onClick={() => setMethod(undefined)}
              >
                <ArrowLeft size={16} /> Back to sign-in methods
              </Button>
              <div className="security-detail-heading">
                <span className="security-method-icon" aria-hidden="true">
                  {selected.icon}
                </span>
                <div>
                  <p className="security-eyebrow">SIGN-IN METHOD</p>
                  <h2 ref={detailHeading} tabIndex={-1}>
                    {selected.title}
                  </h2>
                </div>
                <Badge>{selected.count}</Badge>
              </div>
              {method === "email" ? (
                <>
                  <p className="security-detail-description">
                    Receive a fresh code whenever you choose to sign in by
                    email. Each code can be used once and expires shortly after
                    it is sent.
                  </p>
                  <div className="security-email-address">
                    <Mail size={21} aria-hidden="true" />
                    <div>
                      <span className="muted text-small">Sign-in address</span>
                      <strong>{email || "Your verified email address"}</strong>
                    </div>
                    <Badge tone="success">Email codes</Badge>
                  </div>
                  {security.administrator ? (
                    <Notice
                      tone="info"
                      message="Your administrative access requires a passkey. An email code cannot replace it."
                    />
                  ) : null}
                  <p className="muted text-small security-method-note">
                    Keep access to this inbox and never share a sign-in code.
                    Changing your email address requires verification of the new
                    address.
                  </p>
                  <Button
                    variant="secondary"
                    disabled={task.busy}
                    onClick={() => action("UPDATE_EMAIL")}
                  >
                    Change email address <ArrowRight size={16} />
                  </Button>
                </>
              ) : (
                <>
                  <p className="security-detail-description">
                    {method === "passkeys"
                      ? "Sign in with your device's fingerprint, face or security PIN. Add a second passkey so you have a backup."
                      : "Use time-based codes from your authenticator app to confirm your identity. Each app you set up appears here."}
                  </p>
                  {security.administrator ? (
                    <Notice
                      tone="info"
                      message="Your administrative access requires a passkey. Email codes and authenticator codes cannot replace it."
                    />
                  ) : null}
                  {credentials?.length ? (
                    <div className="security-credential-list">
                      {credentials.map((item) => {
                        const protectedPasskey =
                          method === "passkeys" &&
                          security.administrator &&
                          security.passkeys.length <= 1;
                        return (
                          <div
                            className="list-row security-credential"
                            key={item.id}
                          >
                            <div className="list-row-leading">
                              <span
                                className="security-credential-icon"
                                aria-hidden="true"
                              >
                                {method === "passkeys" ? (
                                  <Fingerprint size={21} />
                                ) : (
                                  <KeyRound size={21} />
                                )}
                              </span>
                              <div>
                                <h3>{item.label}</h3>
                                <p className="muted text-small">
                                  {protectedPasskey
                                    ? "Required for administrative access"
                                    : item.createdAt
                                      ? `Added ${date(item.createdAt)}`
                                      : "Ready to use"}
                                </p>
                              </div>
                            </div>
                            <Button
                              variant="quiet"
                              aria-label={"Remove " + item.label}
                              disabled={task.busy || protectedPasskey}
                              onClick={() => setRemove(item)}
                            >
                              <Trash2 size={16} /> Remove
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <Empty
                      title={
                        method === "passkeys"
                          ? "No passkeys yet"
                          : "No authenticator app yet"
                      }
                    >
                      {method === "passkeys"
                        ? "Create a passkey to sign in with your device."
                        : "Set up an app to generate your own sign-in codes."}
                    </Empty>
                  )}
                  <div className="security-add-method">
                    <Button
                      disabled={task.busy}
                      onClick={() =>
                        action(
                          method === "passkeys"
                            ? "tentu-register-passkey"
                            : "CONFIGURE_TOTP",
                        )
                      }
                    >
                      {method === "passkeys" ? (
                        <Fingerprint size={17} />
                      ) : (
                        <KeyRound size={17} />
                      )}
                      {method === "passkeys" ? "Add passkey" : "Set up app"}
                    </Button>
                    <p className="muted text-small">
                      You may be asked to verify your identity before
                      continuing.
                    </p>
                  </div>
                </>
              )}
            </section>
          ) : (
            <Panel
              title="Sign-in methods"
              description="Choose a method to review its details, add a backup or make a change."
            >
              {security.administrator ? (
                <Notice
                  tone="info"
                  message="Your administrative access requires a passkey. Keep a second one as a backup."
                />
              ) : null}
              <div className="security-method-grid">
                {methods.map((item) => (
                  <button
                    type="button"
                    className="security-method-card cursor-pointer"
                    key={item.id}
                    aria-label={item.label}
                    onClick={() => setMethod(item.id)}
                    ref={(element) => {
                      methodButtons.current[item.id] = element;
                    }}
                  >
                    <span className="security-method-card-top">
                      <span className="security-method-icon" aria-hidden="true">
                        {item.icon}
                      </span>
                      <span className="security-method-state">
                        {item.status}
                      </span>
                    </span>
                    <span className="security-method-title">{item.title}</span>
                    <span className="security-method-description">
                      {item.description}
                    </span>
                    <span className="security-method-card-bottom">
                      <span>{item.count}</span>
                      <ChevronRight size={19} aria-hidden="true" />
                    </span>
                  </button>
                ))}
              </div>
            </Panel>
          )}
          <div className="security-reassurance">
            <ShieldCheck size={22} aria-hidden="true" />
            <div>
              <strong>Keep a way back in.</strong>
              <p>
                Keep a backup sign-in method. If you lose access to all your
                methods, contact an administrator for help with recovery.
              </p>
            </div>
          </div>
        </>
      ) : null}
      {remove ? (
        <Dialog
          title="Remove sign-in method?"
          onClose={() => setRemove(undefined)}
        >
          <p>
            You will verify your identity before removing{" "}
            <strong>{remove.label}</strong>. SCORETech Identity will keep at
            least one usable method and protect your last administrative
            passkey.
          </p>
          <div className="form-actions">
            <Button
              variant="secondary"
              disabled={task.busy}
              onClick={() => setRemove(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={task.busy}
              onClick={() => action("tentu-delete-credential:" + remove.id)}
            >
              Verify and remove
            </Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
function SessionsPanel() {
  const { api, signOut } = useAuth();
  const resource = useResource<{ sessions: Session[] }>(
    config.accountApiUrl + "/sessions",
  );
  const task = useTask();
  const [activity, setActivity] = useState<{
    events: { type: string; time: number; clientId?: string }[];
    applications: string[];
  }>();
  return (
    <>
      {task.feedback}
      <Panel
        title="Active sessions"
        description="A session can connect more than one SCORE service."
        actions={
          <Button
            variant="secondary"
            disabled={task.busy}
            onClick={() =>
              void task.execute("All sessions have been ended.", async () => {
                await api(config.accountApiUrl + "/logout", { method: "POST" });
                await signOut();
              })
            }
          >
            End all sessions
          </Button>
        }
      >
        {resource.error ? (
          <Notice message={resource.error} />
        ) : resource.loading && !resource.data ? (
          <Loading />
        ) : resource.data?.sessions.length ? (
          resource.data.sessions.map((session) => (
            <div className="list-row" key={session.id}>
              <div className="list-row-leading">
                <span className="list-icon">
                  <Monitor size={22} />
                </span>
                <div>
                  <h3>
                    {session.browser || "Browser session"}
                    {session.operatingSystem
                      ? " · " + session.operatingSystem
                      : ""}{" "}
                    {session.current ? (
                      <Badge tone="success">This device</Badge>
                    ) : null}
                  </h3>
                  <p>
                    Last active {date(session.lastAccess)} · {session.ipAddress}
                  </p>
                </div>
              </div>
              <div className="button-group">
                <Button
                  variant="quiet"
                  onClick={() =>
                    void task.execute("", async () =>
                      setActivity(
                        await api(
                          config.accountApiUrl +
                            "/sessions/" +
                            encodeURIComponent(session.id) +
                            "/activity",
                        ),
                      ),
                    )
                  }
                >
                  Activity
                </Button>
                <Button
                  variant="secondary"
                  disabled={task.busy}
                  onClick={() =>
                    void task.execute("Session ended.", async () => {
                      await api(
                        config.accountApiUrl +
                          "/sessions/" +
                          encodeURIComponent(session.id),
                        { method: "DELETE" },
                      );
                      if (session.current) await signOut();
                      else resource.reload();
                    })
                  }
                >
                  End session
                </Button>
              </div>
            </div>
          ))
        ) : (
          <Empty title="No active sessions" />
        )}
      </Panel>
      {activity ? (
        <Dialog title="Session activity" onClose={() => setActivity(undefined)}>
          <p className="muted text-small">
            Connected applications:{" "}
            {activity.applications.join(", ") ||
              "No application information available."}
          </p>
          {activity.events.length ? (
            activity.events.map((event, i) => (
              <div className="list-row" key={i}>
                <strong>{event.type.replaceAll("_", " ")}</strong>
                <small>{date(event.time)}</small>
              </div>
            ))
          ) : (
            <Empty title="No recent identity events" />
          )}
        </Dialog>
      ) : null}
    </>
  );
}
type AccountTheme = "light" | "dark";
function PreferencesPanel() {
  const { api } = useAuth();
  const resource = useResource<{ theme: AccountTheme }>(
    config.accountApiUrl + "/preferences",
  );
  const task = useTask();
  const [theme, setTheme] = useState<AccountTheme>(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  useEffect(() => {
    if (resource.data) setTheme(resource.data.theme);
  }, [resource.data]);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(
        document.documentElement.classList.contains("dark") ? "dark" : "light",
      );
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  const select = async (next: AccountTheme) => {
    if (task.busy || !resource.data) return;
    const previous = document.documentElement.classList.contains("dark")
      ? "dark"
      : "light";
    setTheme(next);
    const saved = await task.execute("Preferences saved.", async () => {
      await api(config.accountApiUrl + "/preferences", {
        method: "PUT",
        body: JSON.stringify({ theme: next }),
      });
      localStorage.setItem("score.appearance", next);
      document.documentElement.classList.toggle("dark", next === "dark");
      resource.reload();
    });
    if (!saved) setTheme(previous);
  };
  return (
    <>
      {task.feedback}
      <Panel
        title="Preferences"
        description="Small choices that make your account feel like yours."
      >
        {resource.error ? <Notice message={resource.error} /> : null}
        {resource.loading && !resource.data ? (
          <Loading />
        ) : resource.data ? (
          <div className="preferences-experience">
            <div className="preferences-settings">
              <p className="preferences-eyebrow">01 / DISPLAY</p>
              <h3>Find your light.</h3>
              <p className="preferences-introduction">
                Light or dark. The same SCORETech Identity, in the setting that
                suits you.
              </p>
              <fieldset
                className="preferences-theme-options"
                disabled={task.busy}
              >
                <legend className="sr-only">Theme</legend>
                {(["light", "dark"] as const).map((value) => (
                  <label
                    className={`preferences-theme-option cursor-pointer ${theme === value ? "is-selected" : ""}`}
                    key={value}
                  >
                    <input
                      className="cursor-pointer"
                      type="radio"
                      name="theme"
                      aria-label={
                        value === "light" ? "Light mode" : "Dark mode"
                      }
                      checked={theme === value}
                      onChange={() => void select(value)}
                    />
                    <span className="preferences-theme-icon" aria-hidden="true">
                      {value === "light" ? (
                        <Sun size={21} />
                      ) : (
                        <Moon size={21} />
                      )}
                    </span>
                    <span>
                      <strong>
                        {value === "light" ? "Light" : "Dark"} mode
                      </strong>
                      <span className="preferences-theme-description">
                        {value === "light"
                          ? "Bright surfaces, clear details."
                          : "A softer view after hours."}
                      </span>
                    </span>
                    <Check
                      className="preferences-theme-check"
                      size={18}
                      aria-hidden="true"
                    />
                  </label>
                ))}
              </fieldset>
              <p className="preferences-save-note">
                <ShieldCheck size={16} aria-hidden="true" /> Saved to your
                account automatically.
              </p>
            </div>
            <div className="preferences-preview-wrap">
              <div className="preferences-preview-label">
                <span>YOUR ACCOUNT, AT A GLANCE</span>
                <span>LIVE PREVIEW</span>
              </div>
              <div
                className="preferences-site-preview"
                data-theme={theme}
                aria-hidden="true"
              >
                <div className="preferences-preview-header">
                  <span className="preferences-preview-logo">S</span>
                  <span className="preferences-preview-brand">
                    SCORETech <span>Identity</span>
                  </span>
                  <span className="preferences-preview-window">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
                <div className="preferences-preview-body">
                  <div className="preferences-preview-sidebar">
                    <span className="is-active">
                      <UserRound size={15} />
                    </span>
                    <span>
                      <Fingerprint size={15} />
                    </span>
                    <span>
                      <Monitor size={15} />
                    </span>
                    <span>
                      <Palette size={15} />
                    </span>
                    <i />
                  </div>
                  <div className="preferences-preview-content">
                    <span className="preferences-preview-eyebrow">
                      ONE ACCOUNT. EVERY CONNECTION.
                    </span>
                    <strong className="preferences-preview-title">
                      Your research.
                      <br />
                      One identity.
                    </strong>
                    <span className="preferences-preview-subtitle">
                      A secure place for your SCORE services.
                    </span>
                    <div className="preferences-preview-profile">
                      <span className="preferences-preview-avatar">
                        <UserRound size={19} />
                      </span>
                      <span>
                        <b>Your profile</b>
                        <i />
                        <i />
                      </span>
                      <ShieldCheck size={17} />
                    </div>
                    <div className="preferences-preview-metrics">
                      <span>
                        <Fingerprint size={17} />
                        <b>Secure access</b>
                        <i />
                      </span>
                      <span>
                        <Monitor size={17} />
                        <b>Connected devices</b>
                        <i />
                      </span>
                    </div>
                    <span className="preferences-preview-action">
                      Manage your account <ArrowRight size={13} />
                    </span>
                  </div>
                </div>
              </div>
              <div className="preferences-preview-caption">
                <span
                  className="preferences-preview-caption-icon"
                  aria-hidden="true"
                >
                  {theme === "dark" ? <Moon size={19} /> : <Sun size={19} />}
                </span>
                <span>
                  <strong>{theme === "dark" ? "Dark" : "Light"} mode</strong>
                  <span>
                    {task.busy
                      ? "Saving your preference…"
                      : "Your account, in a different light."}
                  </span>
                </span>
              </div>
            </div>
          </div>
        ) : null}
        {resource.error ? (
          <Button variant="secondary" onClick={resource.reload}>
            Try again
          </Button>
        ) : null}
      </Panel>
    </>
  );
}
