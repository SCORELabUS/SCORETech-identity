import {
  cloneElement,
  isValidElement,
  useId,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type ButtonHTMLAttributes,
  type FormEvent,
} from "react";
import {
  ArrowUpRight,
  Fingerprint,
  LogOut,
  UserRound,
  ChevronDown,
  ShieldCheck,
  Menu,
  X,
  Check,
  AlertCircle,
} from "lucide-react";
import { Avatar, type AvatarValue } from "./avatar";
export { Avatar, avatarPalette, avatarChoices, avatarColor } from "./avatar";
export type { AvatarValue } from "./avatar";
import { config, useAuth } from "./auth";
export { config, useAuth, useResource, AuthProvider } from "./auth";
export type { IdentityConfig } from "./auth";
export function Button({
  className = "",
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "quiet";
}) {
  return (
    <button
      {...props}
      className={`cursor-pointer button button-${variant} ${className}`}
    />
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {isValidElement(children)
        ? cloneElement(
            children as ReactElement<{
              id?: string;
              "aria-describedby"?: string;
            }>,
            { id, "aria-describedby": hint ? id + "-hint" : undefined },
          )
        : children}
      {hint ? <small id={id + "-hint"}>{hint}</small> : null}
    </div>
  );
}
export function Panel({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function Loading() {
  return (
    <div role="status" aria-label="Loading" className="skeleton">
      <span />
      <span />
      <span />
    </div>
  );
}
export function Notice({
  message,
  tone = "error",
}: {
  message: string;
  tone?: "error" | "success" | "info";
}) {
  return message ? (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`notice notice-${tone}`}
    >
      {tone === "success" ? <Check size={18} /> : <AlertCircle size={18} />}
      <span>{message}</span>
    </div>
  ) : null;
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <ShieldCheck size={28} />
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const pointerStartedOutside = useRef(false);
  const outside = (node: HTMLDialogElement, x: number, y: number) => {
    const bounds = node.getBoundingClientRect();
    return (
      x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom
    );
  };
  useEffect(() => {
    const node = ref.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        pointerStartedOutside.current =
          event.target === event.currentTarget &&
          outside(event.currentTarget, event.clientX, event.clientY);
      }}
      onPointerCancel={() => {
        pointerStartedOutside.current = false;
      }}
      onClick={(event) => {
        const dismiss =
          pointerStartedOutside.current &&
          event.target === event.currentTarget &&
          outside(event.currentTarget, event.clientX, event.clientY);
        pointerStartedOutside.current = false;
        if (dismiss) onClose();
      }}
      aria-label={title}
      className="dialog"
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <Button variant="quiet" aria-label="Close dialog" onClick={onClose}>
          <X size={20} />
        </Button>
      </div>
      {children}
    </dialog>
  );
}
export function useTask() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  const execute = async (label: string, operation: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await operation();
      setSuccess(label);
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to complete this action.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    error,
    success,
    execute,
    feedback: (
      <>
        <Notice message={error} />
        <Notice message={success} tone="success" />
      </>
    ),
  };
}
export function Form({
  children,
  onSubmit,
}: {
  children: ReactNode;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="form" onSubmit={onSubmit}>
      {children}
    </form>
  );
}
export function date(value?: number | string) {
  return value
    ? new Date(value).toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
}
export function SignIn() {
  const { signIn, error } = useAuth();
  const [localError, setLocalError] = useState("");
  return (
    <main className="welcome">
      <div className="welcome-brand">
        <a href="https://score.us.es" className="cursor-pointer wordmark">
          SCORETech<span>Identity</span>
        </a>
        <p className="eyebrow">
          SMART COMPUTER SYSTEMS RESEARCH AND ENGINEERING
        </p>
        <h1>
          One identity.
          <br />A connected
          <br />
          <em>research ecosystem.</em>
        </h1>
        <p>
          Your account connects you to SCORE services. One secure place to
          manage who you are and how you sign in.
        </p>
        <div className="welcome-caption">
          <span className="brand-line" />
          UNIVERSITY OF SEVILLE · SCORE LAB
        </div>
      </div>
      <section className="welcome-card">
        <Fingerprint size={38} />
        <p className="eyebrow">SCORETech Identity</p>
        <h2>
          {config.kind === "admin"
            ? "Administration starts here."
            : "Welcome to your account."}
        </h2>
        <p>
          {config.kind === "admin"
            ? "Manage people, roles and secure access across the SCORE ecosystem."
            : "Sign in with your email code, passkey or authenticator app. No password to remember."}
        </p>
        <Notice message={error || localError} />
        <Button
          onClick={() => void signIn().catch((e) => setLocalError(e.message))}
        >
          Sign in to SCORETech Identity <ArrowUpRight size={18} />
        </Button>
        {config.lab ? (
          <div className="lab-note">
            <Badge>LOCAL LABORATORY</Badge>
            <p>
              Use <strong>admin-score@example.invalid</strong> or{" "}
              <strong>person@example.invalid</strong>. Find your sign-in code in{" "}
              <a
                className="cursor-pointer"
                href="http://localhost:18025"
                target="_blank"
                rel="noreferrer"
              >
                Inbox
              </a>
              .
            </p>
          </div>
        ) : null}
        <p className="welcome-footnote">
          Identity verified centrally. Access granted by your administrator.
        </p>
      </section>
    </main>
  );
}
export function Shell({
  title,
  subtitle,
  section,
  items,
  onNavigate,
  children,
}: {
  title: string;
  subtitle: string;
  section: string;
  items: { id: string; label: string; icon: ReactNode }[];
  onNavigate: (id: string) => void;
  children: ReactNode;
}) {
  const { user, signOut, api } = useAuth();
  const [menu, setMenu] = useState(false);
  const accountMenu = useRef<HTMLDetailsElement>(null);
  const [error, setError] = useState("");
  const [showAdministration, setShowAdministration] = useState(false);
  const [accountProfile, setAccountProfile] = useState<{
    firstName?: string;
    lastName?: string;
    avatar?: AvatarValue;
    profile?: { displayName?: string };
  }>();
  useEffect(() => {
    if (!user) {
      setShowAdministration(false);
      return;
    }
    let active = true;
    const update = async () => {
      try {
        const profile = await api<{
          roles: string[];
          firstName?: string;
          lastName?: string;
          avatar?: AvatarValue;
          profile?: { displayName?: string };
        }>(config.accountApiUrl + "/me");
        if (active) {
          setShowAdministration(profile.roles.includes("administrador"));
          setAccountProfile(profile);
        }
      } catch {
        if (active) setShowAdministration(false);
      }
    };
    void update();
    window.addEventListener("focus", update);
    window.addEventListener("score:profile-updated", update);
    return () => {
      active = false;
      window.removeEventListener("focus", update);
      window.removeEventListener("score:profile-updated", update);
    };
  }, [api, user]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !accountMenu.current?.contains(event.target)
      )
        accountMenu.current?.removeAttribute("open");
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && accountMenu.current?.open) {
        accountMenu.current.open = false;
        accountMenu.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  useEffect(() => {
    const apply = async () => {
      try {
        const { theme } = await api<{ theme: "light" | "dark" }>(
          config.accountApiUrl + "/preferences",
        );
        document.documentElement.classList.toggle("dark", theme === "dark");
        localStorage.setItem("score.appearance", theme);
      } catch {
        /* Identity remains available when appearance cannot load. */
      }
    };
    void apply();
    const focus = () => void apply();
    window.addEventListener("focus", focus);
    return () => {
      window.removeEventListener("focus", focus);
    };
  }, [api]);
  return (
    <div className="workspace">
      <aside
        id="workspace-navigation"
        className={`sidebar ${menu ? "sidebar-open" : ""}`}
      >
        <a
          href={config.kind === "admin" ? config.adminUrl : config.accountUrl}
          className="cursor-pointer wordmark"
        >
          SCORETech<span>Identity</span>
        </a>
        <div className="sidebar-product">
          <span className="brand-line" />
          <span>
            IDENTITY / {config.kind === "admin" ? "ADMIN" : "ACCOUNT"}
          </span>
        </div>
        <nav aria-label="Main navigation">
          {items.map((item) => (
            <button
              key={item.id}
              className={`cursor-pointer nav-item ${section === item.id ? "nav-active" : ""}`}
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => {
                onNavigate(item.id);
                setMenu(false);
              }}
            >
              {item.icon}
              {item.label}
              {section === item.id ? <span className="nav-dot" /> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {config.kind === "account" && showAdministration ? (
            <a className="cursor-pointer ecosystem-link" href={config.adminUrl}>
              Administration <ArrowUpRight size={16} />
            </a>
          ) : null}
          <details ref={accountMenu} className="account-dropdown">
            <summary
              className="identity-card cursor-pointer"
              aria-label="Account menu"
            >
              <Avatar
                value={accountProfile?.avatar}
                name={
                  [accountProfile?.firstName, accountProfile?.lastName]
                    .filter(Boolean)
                    .join(" ") ||
                  String(user?.profile.name || user?.profile.email || "S")
                }
              />
              <div>
                <strong>
                  {accountProfile?.profile?.displayName ||
                    [accountProfile?.firstName, accountProfile?.lastName]
                      .filter(Boolean)
                      .join(" ") ||
                    user?.profile.name ||
                    user?.profile.given_name ||
                    "SCORE member"}
                </strong>
                <small title={user?.profile.email}>{user?.profile.email}</small>
              </div>
              <ChevronDown
                size={16}
                className="account-menu-chevron"
                aria-hidden="true"
              />
            </summary>
            <nav
              className="account-dropdown-options"
              aria-label="Account options"
            >
              <a
                className="cursor-pointer"
                href={config.accountUrl + "#public-profile"}
              >
                <UserRound size={17} /> My profile
              </a>
              <button
                className="cursor-pointer account-signout"
                onClick={() => void signOut().catch((e) => setError(e.message))}
              >
                <LogOut size={17} />
                Sign out
              </button>
            </nav>
          </details>
        </div>
      </aside>
      <div className="workspace-main">
        <main className="page">
          <div className="page-heading">
            <Button
              variant="quiet"
              className="mobile-menu"
              aria-label="Toggle navigation"
              aria-expanded={menu}
              aria-controls="workspace-navigation"
              onClick={() => setMenu(!menu)}
            >
              <Menu size={20} />
            </Button>
            <p className="eyebrow">
              {config.kind === "admin"
                ? "IDENTITY ADMINISTRATION"
                : "Your SCORETech Identity"}
            </p>
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
          <Notice message={error} />
          {children}
        </main>
        <footer className="footer">
          <span>© {new Date().getFullYear()} SCORETech Identity</span>
          <span>
            Smart Computer Systems Research and Engineering · University of
            Seville
          </span>
          <a className="cursor-pointer" href="https://score.us.es">
            SCORE Lab <ArrowUpRight size={13} />
          </a>
        </footer>
      </div>
    </div>
  );
}
