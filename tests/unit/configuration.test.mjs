import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configuration, digest } from "../../tooling/identity-config.mjs";
import { renderProduction } from "../../tooling/render-production.mjs";

async function productionFixture(t) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "score-identity-render-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secretsDirectory = path.join(directory, "secrets");
  const runtime = path.join(directory, "runtime");
  await mkdir(secretsDirectory, { mode: 0o700 });
  const values = Object.fromEntries(
    ["admin", "account", "sync", "smtp-login", "smtp-key"].map((name) => [
      name,
      randomBytes(32).toString("hex"),
    ]),
  );
  const files = {};
  for (const [name, value] of Object.entries(values)) {
    const file = path.join(secretsDirectory, name);
    await writeFile(file, value, { mode: 0o600 });
    files[name] = file;
  }
  const env = {
    IDENTITY_PUBLIC_ORIGIN: "https://identity.example.org",
    IDENTITY_ENVIRONMENT: "production",
    IDENTITY_RUNTIME_DIR: runtime,
    IDENTITY_WEBAUTHN_RP_ID: "identity.example.org",
    IDENTITY_BOOTSTRAP_EMAIL: "operator@example.org",
    IDENTITY_ADMIN_SECRET_FILE: files.admin,
    IDENTITY_ACCOUNT_SECRET_FILE: files.account,
    IDENTITY_SYNC_SECRET_FILE: files.sync,
    BREVO_SMTP_LOGIN_FILE: files["smtp-login"],
    BREVO_SMTP_KEY_FILE: files["smtp-key"],
    BREVO_SENDER_EMAIL: "identity@example.org",
    BREVO_SENDER_NAME: "SCORETech Identity test sender",
  };
  // Rendering must remain local even when inputs resemble deployment settings.
  const fetch = t.mock.method(globalThis, "fetch", () => {
    throw new Error("Renderer tests must not contact external services.");
  });
  return { env, runtime, values, files, fetch };
}

function publicConfiguration(text) {
  const assignment = /^window\.__SCORE_CONFIG__ = (.+);\n$/.exec(text);
  assert.ok(
    assignment,
    "The public file must contain a JSON configuration assignment.",
  );
  return JSON.parse(assignment[1]);
}

test("configuration derives one coherent issuer and prefixed browser URLs", () => {
  const config = configuration({
    IDENTITY_PUBLIC_ORIGIN: "https://identity.example.org:443/",
    IDENTITY_BASE_PATH: "/identity/",
    IDENTITY_REALM: "score",
    IDENTITY_ENVIRONMENT: "production",
  });
  assert.equal(config.origin, "https://identity.example.org");
  assert.equal(config.root, "https://identity.example.org/identity");
  assert.equal(
    config.issuer,
    "https://identity.example.org/identity/auth/realms/score",
  );
  assert.equal(
    config.accountUrl,
    "https://identity.example.org/identity/account/",
  );
  assert.equal(config.adminUrl, "https://identity.example.org/identity/admin/");
  assert.equal(config.providerPath, "/identity/auth");
  assert.equal(config.rpId, "identity.example.org");
});

test("configuration rejects origins containing credentials, paths, queries or fragments", () => {
  for (const origin of [
    "https://operator:password@example.org",
    "https://example.org/identity",
    "https://example.org/?redirect=elsewhere",
    "https://example.org/#fragment",
    "not an origin",
    "ftp://identity.example.org",
  ]) {
    assert.throws(() => configuration({ IDENTITY_PUBLIC_ORIGIN: origin }));
  }
});

test("deployed configuration requires HTTPS and a recognized environment", () => {
  for (const environment of ["staging", "production"]) {
    assert.throws(
      () =>
        configuration({
          IDENTITY_PUBLIC_ORIGIN: "http://identity.example.org",
          IDENTITY_ENVIRONMENT: environment,
        }),
      /HTTPS/,
    );
  }
  assert.throws(
    () => configuration({ IDENTITY_ENVIRONMENT: "unknown" }),
    /environment/,
  );
  assert.equal(
    configuration({}).issuer,
    "http://localhost:18000/identity/auth/realms/score",
  );
});

test("configuration rejects invalid base paths and realm identifiers", () => {
  for (const basePath of [
    "identity",
    "/identity?query",
    "/identity space",
    "/../identity",
  ]) {
    assert.throws(
      () => configuration({ IDENTITY_BASE_PATH: basePath }),
      /BASE_PATH/,
    );
  }
  for (const realm of ["SCORE", "score/other", "score.realm"]) {
    assert.throws(() => configuration({ IDENTITY_REALM: realm }), /realm/);
  }
});

test("snapshot digests ignore object-key ordering but preserve array order", () => {
  assert.equal(
    digest({ roles: ["member", "support"], generation: 1 }),
    digest({ generation: 1, roles: ["member", "support"] }),
  );
  assert.notEqual(
    digest({ roles: ["member", "support"] }),
    digest({ roles: ["support", "member"] }),
  );
});

test("production rendering refuses local mode and missing deployment inputs", async (t) => {
  const { env, fetch } = await productionFixture(t);
  await assert.rejects(
    renderProduction({ ...env, IDENTITY_ENVIRONMENT: "local" }),
    /local environment/,
  );
  for (const name of [
    "IDENTITY_PUBLIC_ORIGIN",
    "IDENTITY_RUNTIME_DIR",
    "IDENTITY_WEBAUTHN_RP_ID",
    "IDENTITY_BOOTSTRAP_EMAIL",
    "BREVO_SENDER_EMAIL",
    "IDENTITY_ADMIN_SECRET_FILE",
    "IDENTITY_ACCOUNT_SECRET_FILE",
    "IDENTITY_SYNC_SECRET_FILE",
    "BREVO_SMTP_LOGIN_FILE",
    "BREVO_SMTP_KEY_FILE",
  ]) {
    const incomplete = { ...env };
    delete incomplete[name];
    await assert.rejects(renderProduction(incomplete), new RegExp(name));
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("production rendering rejects fixture identities, credentials and reused service secrets", async (t) => {
  const { env, files, fetch } = await productionFixture(t);
  await assert.rejects(
    renderProduction({
      ...env,
      IDENTITY_BOOTSTRAP_EMAIL: "admin-score@example.invalid",
    }),
    /email address/,
  );
  await assert.rejects(
    renderProduction({ ...env, BREVO_SENDER_EMAIL: "sender@example.invalid" }),
    /email address/,
  );
  await assert.rejects(
    renderProduction({
      ...env,
      IDENTITY_ACCOUNT_SECRET_FILE: env.IDENTITY_ADMIN_SECRET_FILE,
    }),
    /distinct credentials/,
  );
  await writeFile(files.admin, "fixture-local-admin-service", { mode: 0o600 });
  await assert.rejects(renderProduction(env), /non-fixture service credential/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("production rendering rejects contaminated laboratory runtime directories", async (t) => {
  const { env, runtime, fetch } = await productionFixture(t);
  for (const marker of ["github/state.json", "keys/github.pem"]) {
    const file = path.join(runtime, marker);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, randomBytes(16).toString("hex"), { mode: 0o600 });
    await assert.rejects(renderProduction(env), /laboratory fixtures/);
    await rm(file);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("production rendering validates the RP domain and derives bundled document references", async (t) => {
  const { env, fetch } = await productionFixture(t);
  for (const rpId of [
    "unrelated.example.net",
    "https://identity.example.org",
    "localhost",
  ]) {
    await assert.rejects(
      renderProduction({ ...env, IDENTITY_WEBAUTHN_RP_ID: rpId }),
      /RP_ID/,
    );
  }
  const artifacts = await renderProduction({
    ...env,
    IDENTITY_WEBAUTHN_RP_ID: "example.org",
  });
  assert.equal(artifacts.realm.webAuthnPolicyPasswordlessRpId, "example.org");
  assert.equal(fetch.mock.callCount(), 0);
});

test("production rendering keeps secrets private and emits only public deployment metadata to browsers", async (t) => {
  const { env, runtime, values, fetch } = await productionFixture(t);
  const artifacts = await renderProduction(env);
  for (const relative of [
    "import/score-realm.json",
    "catalogue-seed.json",
    "catalogue/catalogue.json",
    "catalogue/apply-status.json",
    "coordination/authorization.lock",
  ]) {
    assert.equal(
      (await stat(path.join(runtime, relative))).mode & 0o777,
      0o600,
      relative,
    );
  }
  const realm = JSON.parse(
    await readFile(path.join(runtime, "import/score-realm.json"), "utf8"),
  );
  assert.equal(realm.realm, "score");
  assert.equal(realm.defaultLocale, "en");
  assert.deepEqual(realm.supportedLocales, ["en"]);
  assert.equal(realm.sslRequired, "external");
  assert.equal(
    realm.clients.find((client) => client.clientId === "identity-admin-service")
      .secret,
    values.admin,
  );
  assert.equal(
    realm.clients.find(
      (client) => client.clientId === "identity-account-service",
    ).secret,
    values.account,
  );
  for (const kind of ["terms", "privacy"]) {
    assert.equal(
      realm.attributes[`tentu.legal.${kind}.url`],
      env.IDENTITY_PUBLIC_ORIGIN + "/identity/legal/" + kind,
    );
    assert.match(
      realm.attributes[`tentu.legal.${kind}.digest`],
      /^sha256:[a-f0-9]{64}$/,
    );
    const html = await readFile(
      path.join(runtime, `web/legal/${kind}.html`),
      "utf8",
    );
    assert.match(html, /infoscore@us.es/);
    for (const secret of Object.values(values))
      assert.ok(!html.includes(secret));
  }
  assert.equal(realm.smtpServer.password, values["smtp-key"]);
  assert.equal(realm.smtpServer.ssl, "false");
  assert.equal(realm.smtpServer.starttls, "true");
  assert.equal(realm.smtpServer.port, "587");
  const operator = realm.users.find((user) => !user.serviceAccountClientId);
  assert.equal(operator.email, env.IDENTITY_BOOTSTRAP_EMAIL);
  assert.equal(operator.emailVerified, false);
  assert.equal(operator.credentials, undefined);
  assert.deepEqual(
    artifacts.roles.find((role) => role.name === "member").permissions,
    [],
  );
  for (const kind of ["account", "admin"]) {
    const file = path.join(runtime, `web/${kind}.js`);
    const contents = await readFile(file, "utf8");
    assert.equal((await stat(file)).mode & 0o777, 0o644);
    const browser = publicConfiguration(contents);
    assert.equal(browser.lab, false);
    assert.equal(
      browser.issuer,
      "https://identity.example.org/identity/auth/realms/score",
    );
    assert.equal(browser.clientId, `identity-${kind}-web`);
    assert.equal(
      browser.baseUrl,
      `https://identity.example.org/identity/${kind}/`,
    );
    for (const secret of Object.values(values))
      assert.ok(!contents.includes(secret));
    for (const fixture of [
      "fixture-local-",
      "example.invalid",
      "catalogue-fixture",
    ])
      assert.ok(!contents.includes(fixture));
    assert.equal(browser.serviceSecrets, undefined);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("rerendering preserves legacy catalogue files for one-time database migration", async (t) => {
  const { env, runtime, fetch } = await productionFixture(t);
  const catalogueDirectory = path.join(runtime, "catalogue");
  await mkdir(catalogueDirectory, { recursive: true });
  const existing = {
    "catalogue.json": JSON.stringify({
      permissions: ["reviewed:permission"],
      roles: ["reviewed-role"],
    }),
    "active-registry.json": JSON.stringify({
      generation: 42,
      revision: randomBytes(32).toString("hex"),
    }),
    "apply-status.json": JSON.stringify({
      state: "applied",
      observedRevision: "reviewed-revision",
      generation: 42,
    }),
  };
  for (const [name, value] of Object.entries(existing)) {
    await writeFile(path.join(catalogueDirectory, name), value, {
      mode: 0o600,
    });
  }
  await renderProduction(env);
  await renderProduction(env);
  for (const [name, value] of Object.entries(existing)) {
    assert.equal(
      await readFile(path.join(catalogueDirectory, name), "utf8"),
      value,
      name,
    );
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("production SMTP selects STARTTLS for submission ports and implicit TLS only for 465", async (t) => {
  const { env, fetch } = await productionFixture(t);
  for (const port of ["587", "2525", "465"]) {
    const { realm } = await renderProduction({ ...env, BREVO_SMTP_PORT: port });
    assert.equal(realm.smtpServer.port, port);
    assert.equal(realm.smtpServer.ssl, port === "465" ? "true" : "false");
    assert.equal(realm.smtpServer.starttls, port === "465" ? "false" : "true");
    assert.equal(realm.smtpServer.auth, "true");
  }
  for (const port of ["25", "0", "587x", "465.0", "65536"])
    await assert.rejects(
      renderProduction({ ...env, BREVO_SMTP_PORT: port }),
      /BREVO_SMTP_PORT/,
    );
  assert.equal(fetch.mock.callCount(), 0);
});

test("Brevo API mode renders the sender without SMTP credentials or the API key", async (t) => {
  const { env, fetch, runtime } = await productionFixture(t);
  delete env.BREVO_SMTP_LOGIN_FILE;
  delete env.BREVO_SMTP_KEY_FILE;
  const { realm } = await renderProduction({
    ...env,
    BREVO_EMAIL_TRANSPORT: "api",
    BREVO_API_KEY: "test-api-key-that-must-not-be-rendered",
  });
  assert.deepEqual(realm.smtpServer, {
    from: env.BREVO_SENDER_EMAIL,
    fromDisplayName: env.BREVO_SENDER_NAME,
  });
  const rendered = await readFile(
    path.join(runtime, "import/score-realm.json"),
    "utf8",
  );
  assert.ok(!rendered.includes("test-api-key-that-must-not-be-rendered"));
  assert.equal(fetch.mock.callCount(), 0);
});
