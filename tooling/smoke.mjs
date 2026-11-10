import assert from "node:assert/strict";
const host = process.env.SMOKE_ORIGIN || "http://gateway:18000";
for (const endpoint of [
  "/identity/account/",
  "/identity/admin/",
  "/identity/legal/terms",
  "/identity/legal/privacy",
  "/identity/api/account/health",
  "/identity/api/admin/health",
  "/identity/auth/realms/score/.well-known/openid-configuration",
]) {
  const r = await fetch(host + endpoint);
  assert.equal(r.status, 200, endpoint);
  if (endpoint.endsWith("/health")) {
    const expected = endpoint.includes("/admin/")
      ? "identity-admin-api"
      : "identity-account-api";
    assert.equal((await r.json()).service, expected, endpoint + " upstream");
  }
}
const discovery = await fetch(
  host + "/identity/auth/realms/score/.well-known/openid-configuration",
).then((r) => r.json());
assert.match(discovery.issuer, /\/identity\/auth\/realms\/score$/);
for (const endpoint of [
  "/identity/api/account/v1/account/me",
  "/identity/api/admin/v1/users",
])
  assert.equal((await fetch(host + endpoint)).status, 401, endpoint);
for (const endpoint of [
  "/identity/auth/admin/",
  "/identity/auth/realms/master/",
  "/identity/api/admin/v1/oppositions",
  "/identity/api/account/v1/account/payments",
]) {
  const r = await fetch(host + endpoint);
  assert.ok([401, 404].includes(r.status), endpoint + ": " + r.status);
}
for (const endpoint of [
  "score-catalogue",
  "score-applications",
  "score-identities",
  "account/linked-accounts",
  "tentu-authorization/snapshot",
  "tentu-user-mutations",
  "tentu-support",
  "tentu-recovery/users",
])
  assert.equal(
    (await fetch(host + "/identity/auth/realms/score/" + endpoint)).status,
    404,
    "Internal provider endpoint: " + endpoint,
  );
console.log(
  "Laboratory smoke checks passed: triplet, issuer, protected APIs and route boundaries.",
);
