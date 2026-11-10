import {
  reconcileExternalSso,
  reconcileAccountLinking,
} from "./external-sso.mjs";
import { readFile } from "node:fs/promises";
import { acquireAuthorizationLock } from "../packages/identity-internal/dist/coordination.js";
import { loadConfig } from "../apps/admin-api/dist/main/config/app-config.js";
const config = loadConfig();
const realm = JSON.parse(
  await readFile(
    (process.env.IDENTITY_RUNTIME_DIR || "/runtime") +
      "/import/score-realm.json",
    "utf8",
  ),
);
if (realm.realm !== config.APP_KEYCLOAK_REALM)
  throw new Error("Realm configuration mismatch.");
const transport = (
  config.APP_KEYCLOAK_TRANSPORT_URL || config.APP_KEYCLOAK_ISSUER
).replace(/\/$/, "");
let result;
for (let attempt = 0; attempt < 60; attempt++) {
  result = await fetch(transport + "/protocol/openid-connect/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.APP_KEYCLOAK_ADMIN_CLIENT_ID,
      client_secret: config.APP_KEYCLOAK_ADMIN_CLIENT_SECRET,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (result.ok) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!result?.ok)
  throw new Error("Realm reconciliation credential did not become ready.");
const { access_token } = await result.json();
const headers = {
  Authorization: "Bearer " + access_token,
  "Content-Type": "application/json",
};
const base =
  config.APP_KEYCLOAK_ADMIN_URL.replace(/\/$/, "") +
  "/admin/realms/" +
  encodeURIComponent(config.APP_KEYCLOAK_REALM);
const call = async (path, method = "GET", body) => {
  const response = await fetch(base + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`Realm configuration failed (${response.status}).`);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
};
const release = await acquireAuthorizationLock(
  process.env.APP_AUTHORIZATION_LOCK_FILE,
);
try {
  await reconcileExternalSso(call, realm);
  await reconcileAccountLinking(call);
  const profile = await call("/users/profile");
  profile.unmanagedAttributePolicy = "ADMIN_EDIT";
  await call("/users/profile", "PUT", profile);
  const current = await call("");
  const attributes = { ...current.attributes };
  for (const [key, value] of Object.entries(realm.attributes))
    if (
      key.startsWith("tentu.legal.") ||
      key === "tentu.registration.default-role"
    )
      attributes[key] = value;
  await call("", "PUT", {
    ...current,
    displayName: realm.displayName,
    webAuthnPolicyPasswordlessRpEntityName:
      realm.webAuthnPolicyPasswordlessRpEntityName,
    defaultLocale: "en",
    supportedLocales: ["en"],
    loginTheme: "score",
    emailTheme: "score",
    registrationAllowed: true,
    smtpServer: realm.smtpServer,
    webAuthnPolicyPasswordlessRpId: realm.webAuthnPolicyPasswordlessRpId,
    attributes,
  });
  for (const desired of realm.clients.filter((client) =>
    [
      "identity-admin-web",
      "identity-account-web",
      "account",
      "account-console",
      "identity-account-service",
      "identity-admin-service",
    ].includes(client.clientId),
  )) {
    const [existing] = await call(
      "/clients?clientId=" + encodeURIComponent(desired.clientId),
    );
    if (existing)
      await call("/clients/" + existing.id, "PUT", {
        ...existing,
        ...desired,
        attributes: { ...existing.attributes, ...desired.attributes },
      });
    else await call("/clients", "POST", desired);
  }
  console.log(
    "Managed realm profile, browser callbacks, SMTP and public references reconciled. User records and credentials preserved.",
  );
} finally {
  release();
}
