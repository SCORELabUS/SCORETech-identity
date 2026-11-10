import {
  reconcileExternalSso,
  reconcileAccountLinking,
} from "./external-sso.mjs";
// Local-only reconciliation. Never points at or reads deployed credentials.
import { readFile } from "node:fs/promises";
import { acquireAuthorizationLock } from "../packages/identity-internal/dist/coordination.js";
const realm = JSON.parse(
  await readFile("/runtime/import/score-realm.json", "utf8"),
);
if (process.env.APP_IDENTITY_ENVIRONMENT !== "local")
  throw new Error("Laboratory bootstrap is local-only.");
const base = "http://keycloak:8080/identity/auth";
let login;
for (let attempt = 0; attempt < 60; attempt++) {
  login = await fetch(base + "/realms/master/protocol/openid-connect/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: "fixture-admin",
      password: "fixture-local-only",
    }),
    redirect: "error",
  });
  if (login.ok) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!login?.ok)
  throw new Error(
    "Local fixture bootstrap authentication did not become ready.",
  );
const { access_token } = await login.json();
const headers = {
  Authorization: "Bearer " + access_token,
  "Content-Type": "application/json",
};
const root = base + "/admin/realms/" + encodeURIComponent(realm.realm);
const request = async (suffix, method = "GET", body) => {
  const r = await fetch(root + suffix, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error("Local realm reconciliation failed: " + r.status);
  const text = await r.text();
  return text ? JSON.parse(text) : undefined;
};
const release = await acquireAuthorizationLock(
  process.env.APP_AUTHORIZATION_LOCK_FILE,
);
try {
  await reconcileExternalSso(request, realm);
  await reconcileAccountLinking(request);
  const profile = await request("/users/profile");
  profile.unmanagedAttributePolicy = "ADMIN_EDIT";
  await request("/users/profile", "PUT", profile);
  const currentRealm = await request("");
  await request("", "PUT", {
    displayName: realm.displayName,
    attributes: {
      ...currentRealm.attributes,
      "tentu.registration.default-role":
        realm.attributes["tentu.registration.default-role"],
    },
    webAuthnPolicyPasswordlessRpEntityName:
      realm.webAuthnPolicyPasswordlessRpEntityName,
    smtpServer: {
      ...currentRealm.smtpServer,
      fromDisplayName: realm.smtpServer.fromDisplayName,
    },
  });
  // Existing databases ignore realm imports. Rename the original lab fixture in
  // place so its subject, role assignments and enrolled credentials survive.
  const previousEmail = "admin@example.invalid";
  const adminEmail = "admin-score@example.invalid";
  const previous = await request(
    "/users?username=" + encodeURIComponent(previousEmail) + "&exact=true",
  );
  if (previous.length) {
    if (
      previous.length !== 1 ||
      ![previousEmail, adminEmail].includes(previous[0].email)
    )
      throw new Error(
        "The original laboratory administrator no longer matches its fixture.",
      );
    const existing = await request(
      "/users?email=" + encodeURIComponent(adminEmail) + "&exact=true",
    );
    if (existing.some((user) => user.id !== previous[0].id))
      throw new Error(
        "The new laboratory administrator email already belongs to another account.",
      );
    const user = await request("/users/" + previous[0].id);
    const settings = await request("");
    if (!settings.editUsernameAllowed)
      await request("", "PUT", { editUsernameAllowed: true });
    try {
      await request("/users/" + user.id, "PUT", {
        ...user,
        username: adminEmail,
        email: adminEmail,
      });
      const renamed = await request("/users/" + user.id);
      if (renamed.username !== adminEmail || renamed.email !== adminEmail)
        throw new Error("The laboratory administrator rename was not applied.");
    } finally {
      if (!settings.editUsernameAllowed)
        await request("", "PUT", { editUsernameAllowed: false });
    }
    console.log("Local administrator renamed in place to " + adminEmail + ".");
  }
  for (const desired of realm.clients.filter((c) =>
    [
      "identity-admin-web",
      "identity-account-web",
      "account",
      "account-console",
      "lab-service-web",
    ].includes(c.clientId),
  )) {
    const [existing] = await request(
      "/clients?clientId=" + encodeURIComponent(desired.clientId),
    );
    if (existing)
      await request("/clients/" + existing.id, "PUT", {
        ...existing,
        ...desired,
        attributes: { ...existing.attributes, ...desired.attributes },
      });
    else if (desired.clientId === "lab-service-web")
      await request("/clients", "POST", desired);
  }
  console.log(
    "Local custom profile policy and browser callbacks reconciled; identities and credentials preserved.",
  );
} finally {
  release();
}
