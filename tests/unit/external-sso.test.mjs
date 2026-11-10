import test from "node:test";
import assert from "node:assert/strict";
import {
  externalProviders,
  loadExternalSso,
  reconcileExternalSso,
  reconcileAccountLinking,
} from "../../tooling/external-sso.mjs";

test("external identity uses native Google and CAS brokers with safe flows", () => {
  const providers = externalProviders({
    google: {
      enabled: true,
      clientId: "fixture-id",
      clientSecret: "fixture-only",
    },
    us: {
      enabled: true,
      callbackUrl:
        "https://sphere.score.us.es/api/v1/users/auth/sso/us/callback",
    },
  });
  assert.deepEqual(
    providers.map((p) => p.providerId),
    ["google", "score-us-cas"],
  );
  for (const p of providers) {
    assert.equal(p.trustEmail, false);
    assert.equal(p.storeToken, false);
    assert.equal(p.postBrokerLoginFlowAlias, "score-post-broker-login");
    assert.equal(p.firstBrokerLoginFlowAlias, "score-first-broker-login-v1");
  }
  assert.equal(providers[1].config.casUrl, "https://sso.us.es/CAS");
});
test("unconfigured providers stay off; incomplete enabled Google fails closed", async () => {
  assert.deepEqual(externalProviders({}), []);
  assert.deepEqual(await loadExternalSso("/missing-score-sso"), []);
  assert.throws(
    () => externalProviders({ google: { enabled: true, clientId: "id" } }),
    /requires/,
  );
});
test("CAS rejects insecure or ambiguous service configuration", () => {
  for (const callbackUrl of [
    "http://example.org/callback",
    "https://user:password@example.org/callback",
    "https://example.org/callback?state=x",
    "https://example.org/callback#fragment",
  ])
    assert.throws(() =>
      externalProviders({ us: { enabled: true, callbackUrl } }),
    );
  assert.throws(() =>
    externalProviders({
      us: { enabled: true, casUrl: "http://localhost:9999" },
    }),
  );
  assert.equal(
    externalProviders(
      { us: { enabled: true, casUrl: "http://localhost:9999" } },
      true,
    ).length,
    1,
  );
});
test("reconciliation disables removed managed brokers without deleting unrelated providers", async () => {
  const writes = [];
  const call = async (path, method = "GET", body) => {
    if (method !== "GET") {
      writes.push({ path, body });
      return;
    }
    if (path === "/authentication/required-actions") return [];
    if (path === "/identity-provider/instances")
      return [
        { alias: "google", enabled: true },
        { alias: "other", enabled: true },
      ];
    throw new Error(path);
  };
  await reconcileExternalSso(call, {
    authenticationFlows: [],
    identityProviders: [],
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.enabled, false);
  assert.equal(writes[0].body.alias, "google");
});

test("account linking defines native role prerequisites but grants only manage-account-links", async () => {
  const writes = [];
  const role = { id: "links", name: "manage-account-links" };
  const call = async (path, method = "GET", body) => {
    if (method !== "GET") {
      writes.push({ path, body });
      return;
    }
    if (path === "/clients?clientId=account") return [{ id: "account" }];
    if (path === "/clients?clientId=identity-account-web")
      return [{ id: "web" }];
    if (path === "/clients/account/roles") return [];
    if (path === "/clients/account/roles/manage-account-links") return role;
    if (path === "") return { defaultRole: { id: "default" } };
    throw Error(path);
  };
  await reconcileAccountLinking(call);
  assert.deepEqual(
    writes
      .filter((w) => w.path === "/clients/account/roles")
      .map((w) => w.body.name),
    ["manage-account", "manage-account-links"],
  );
  const grants = writes.filter((w) => Array.isArray(w.body));
  assert.deepEqual(
    grants.map((w) => w.path),
    [
      "/roles-by-id/default/composites",
      "/clients/web/scope-mappings/clients/account",
    ],
  );
  assert.ok(
    grants.every(
      (w) => w.body.length === 1 && w.body[0].name === "manage-account-links",
    ),
  );
});
