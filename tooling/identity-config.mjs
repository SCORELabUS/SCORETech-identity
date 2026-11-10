import { createHash } from "node:crypto";
export function configuration(env = process.env) {
  const origin = new URL(
    env.IDENTITY_PUBLIC_ORIGIN || "http://localhost:18000",
  );
  if (!["http:", "https:"].includes(origin.protocol))
    throw new Error("IDENTITY_PUBLIC_ORIGIN must use HTTP or HTTPS.");
  if (
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw new Error("IDENTITY_PUBLIC_ORIGIN must be an origin without a path.");
  const basePath = (env.IDENTITY_BASE_PATH || "/identity").replace(/\/$/, "");
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(basePath))
    throw new Error("Invalid IDENTITY_BASE_PATH.");
  const realm = env.IDENTITY_REALM || "score";
  if (!/^[a-z][a-z0-9-]*$/.test(realm)) throw new Error("Invalid realm.");
  const environment = env.IDENTITY_ENVIRONMENT || "local";
  if (!["local", "staging", "production"].includes(environment))
    throw new Error("Invalid identity environment.");
  if (environment !== "local" && origin.protocol !== "https:")
    throw new Error("Deployed identity requires HTTPS.");
  const root = origin.origin + basePath;
  return {
    origin: origin.origin,
    basePath,
    realm,
    environment,
    root,
    providerPath: basePath + "/auth",
    issuer: root + "/auth/realms/" + realm,
    accountUrl: root + "/account/",
    adminUrl: root + "/admin/",
    rpId: env.IDENTITY_WEBAUTHN_RP_ID || origin.hostname,
  };
}
export const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(",")}}`
      : JSON.stringify(value);
export const digest = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
