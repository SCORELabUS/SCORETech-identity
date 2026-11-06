import { createSessionAccess, sessionRejected } from "./session";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { UserManager, WebStorageStateStore, type User } from "oidc-client-ts";
export interface IdentityConfig {
  kind: "account" | "admin";
  origin: string;
  basePath: string;
  environment: string;
  issuer: string;
  clientId: string;
  baseUrl: string;
  accountUrl: string;
  adminUrl: string;
  accountApiUrl: string;
  adminApiUrl: string;
  lab?: boolean;
}
declare global {
  interface Window {
    __SCORE_CONFIG__: IdentityConfig;
  }
}
export const config = window.__SCORE_CONFIG__;
if (!config?.issuer || !config.baseUrl || !config.clientId)
  throw new Error("Identity public configuration is missing.");
export const manager = new UserManager({
  authority: config.issuer,
  client_id: config.clientId,
  redirect_uri: config.baseUrl + "auth/callback",
  popup_redirect_uri: config.baseUrl + "auth/verification-callback",
  post_logout_redirect_uri: config.baseUrl,
  response_type: "code",
  scope: "openid profile email",
  automaticSilentRenew: false,
  userStore: new WebStorageStateStore({
    store: sessionStorage,
    prefix: "score.user.",
  }),
  stateStore: new WebStorageStateStore({
    store: sessionStorage,
    prefix: "score.state.",
  }),
});
const session = createSessionAccess(manager);
let initialization: Promise<User | null> | undefined;
async function initialize() {
  if (
    location.pathname ===
    new URL(config.baseUrl).pathname + "auth/verification-callback"
  ) {
    await manager.signinPopupCallback();
    return null;
  }
  if (
    location.pathname ===
    new URL(config.baseUrl).pathname + "auth/callback"
  ) {
    const user = await manager.signinRedirectCallback();
    const state = user.state as { hash?: string } | undefined;
    sessionStorage.removeItem("score.invitation.ticket");
    history.replaceState({}, "", config.baseUrl + (state?.hash || ""));
    return user;
  }
  if (location.pathname === new URL(config.baseUrl).pathname + "invite") {
    const ticket = location.hash.slice(1);
    history.replaceState({}, "", config.baseUrl + "invite");
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket))
      throw new Error(
        "This invitation is invalid or expired. Open the original link.",
      );
    sessionStorage.setItem("score.invitation.ticket", ticket);
    await manager.removeUser();
    await manager.signinRedirect({
      prompt: "login",
      max_age: 0,
      extraQueryParams: { invitation_ticket: ticket },
      ui_locales: "en",
    });
    return null;
  }
  const user = await manager.getUser();
  return user ? (user.expired ? session.renew() : user) : null;
}
interface Auth {
  user: User | null;
  loading: boolean;
  error: string;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  renew: () => Promise<void>;
  api: <T = unknown>(path: string, options?: RequestInit) => Promise<T>;
  stepUp: (scope: string) => Promise<void>;
  accountAction: (action: string) => Promise<void>;
  can: (permission: string) => boolean;
}
const Context = createContext<Auth | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const loaded = (value: User) => {
      clearTimeout(retry);
      if (active) {
        setUser(value);
        setError("");
      }
    };
    const removed = () => {
      clearTimeout(retry);
      if (active) setUser(null);
    };
    manager.events.addUserLoaded(loaded);
    manager.events.addUserUnloaded(removed);
    const refresh = () => {
      clearTimeout(retry);
      void session.renew().catch((cause) => {
        if (!active) return;
        setError(
          sessionRejected(cause)
            ? "Your session has expired. Sign in again."
            : "Your session could not be renewed. Retrying…",
        );
        if (!sessionRejected(cause)) retry = setTimeout(refresh, 5000);
      });
    };
    manager.events.addAccessTokenExpiring(refresh);
    manager.events.addAccessTokenExpired(refresh);
    void (initialization ??= initialize())
      .then((value) => {
        if (active) setUser(value);
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error ? cause.message : "Unable to sign in.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      manager.events.removeUserLoaded(loaded);
      manager.events.removeUserUnloaded(removed);
      clearTimeout(retry);
      manager.events.removeAccessTokenExpiring(refresh);
      manager.events.removeAccessTokenExpired(refresh);
    };
  }, []);
  const signIn = useCallback(async () => {
    setError("");
    await manager.signinRedirect({
      ui_locales: "en",
      state: { hash: location.hash },
    });
  }, []);
  const signOut = useCallback(async () => {
    setError("");
    await manager.signoutRedirect();
  }, []);
  const renew = useCallback(async () => {
    const refreshed = await session.renew();
    if (!refreshed)
      throw new Error("Your session could not be renewed. Sign in again.");
    setUser(refreshed);
    setError("");
  }, []);
  const api = useCallback(
    async <T,>(path: string, options: RequestInit = {}) => {
      const response = await session.request(path, {
        ...options,
        headers: { "Content-Type": "application/json", ...options.headers },
        cache: "no-store",
        redirect: "error",
      });
      const text = await response.text();
      let body: any;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        throw new Error("The server returned an invalid response.");
      }
      if (!response.ok) {
        throw new Error(
          body?.error?.message || "Unable to complete this action.",
        );
      }
      return body as T;
    },
    [],
  );
  const stepUp = useCallback(
    async (scope: string) => {
      const endpoint =
        config.kind === "admin" ? config.adminApiUrl : config.accountApiUrl;
      const challenge = await api<{ ticket: string }>(endpoint + "/step-up", {
        method: "POST",
        body: JSON.stringify({ scope, origin: location.origin }),
      });
      await manager.signinPopup({
        prompt: "login",
        max_age: 0,
        ui_locales: "en",
        extraQueryParams: { step_up_ticket: challenge.ticket },
        popupWindowFeatures: { width: 560, height: 760 },
      });
    },
    [api],
  );
  const accountAction = useCallback(async (action: string) => {
    await manager.signinRedirect({
      ui_locales: "en",
      state: { hash: location.hash },
      ...(action === "tentu-register-passkey"
        ? { max_age: 300 }
        : { prompt: "login", max_age: 0 }),
      extraQueryParams: { kc_action: action },
    });
  }, []);
  const value = useMemo<Auth>(
    () => ({
      user,
      loading,
      error,
      signIn,
      signOut,
      renew,
      api,
      stepUp,
      accountAction,
      can(permission) {
        if (!user) return false;
        try {
          return (
            JSON.parse(
              atob(
                user.access_token
                  .split(".")[1]
                  .replace(/-/g, "+")
                  .replace(/_/g, "/"),
              ),
            ).realm_access?.roles || []
          ).includes(permission);
        } catch {
          return false;
        }
      },
    }),
    [user, loading, error, signIn, signOut, renew, api, stepUp, accountAction],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useAuth() {
  const value = useContext(Context);
  if (!value) throw new Error("Missing AuthProvider.");
  return value;
}
export function useResource<T>(path: string) {
  const { api } = useAuth();
  const [data, setData] = useState<T>(),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api<T>(path)
      .then((value) => {
        if (active) setData(value);
      })
      .catch((cause) => {
        if (active) setError(cause.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, path, revision]);
  return {
    data,
    loading,
    error,
    reload: useCallback(() => setRevision((n) => n + 1), []),
  };
}
