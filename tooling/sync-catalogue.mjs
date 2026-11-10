import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { loadConfig } from "../apps/admin-api/dist/main/config/app-config.js";
import { Github } from "../apps/admin-api/dist/main/modules/catalogue/github.js";
import { digest } from "./identity-config.mjs";
import { acquireAuthorizationLock } from "../packages/identity-internal/dist/coordination.js";
const config = loadConfig();
const github = new Github(config);
let lastAppliedHead;
let lastVerification = 0;
const dir = path.dirname(config.APP_AUTHORIZATION_CATALOGUE_PATH);
await mkdir(dir, { recursive: true });
const atomic = async (file, value) => {
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
};
const status = async (value) =>
  atomic(config.APP_CATALOGUE_STATE_PATH, {
    ...value,
    updatedAt: new Date().toISOString(),
  });
const realmUrl = (
  config.APP_KEYCLOAK_TRANSPORT_URL || config.APP_KEYCLOAK_ISSUER
).replace(/\/$/, "");
async function checked(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      `Identity synchronization request failed (${response.status}).`,
    );
  return response.status === 204 ? undefined : response.json();
}
async function run() {
  const head = await github.head();
  // Recheck the provider periodically even without a Git change, e.g. after a
  // database restore. An old projection must never mask provider drift forever.
  if (head === lastAppliedHead && Date.now() - lastVerification < 60000) return;
  const overlay = parse(
    await github.file(
      `environments/${config.APP_IDENTITY_ENVIRONMENT}/identity-config-sync.yaml`,
      head,
    ),
  );
  if (
    overlay.service !== "identity-config-sync" ||
    overlay.enabled !== true ||
    overlay.valueFiles?.length !== 1
  )
    throw new Error("Invalid synchronization source.");
  const source = overlay.valueFiles[0];
  if (
    !/^environments\/identity\/generated\/revisions\/(?:local|staging|production)\/[a-f0-9]{64}\.yaml$/.test(
      source,
    )
  )
    throw new Error("Invalid snapshot reference.");
  const snapshot = parse(await github.file(source, head));
  const { enabled, ...registry } = snapshot.authorizationRegistry || {};
  const copy = structuredClone(snapshot);
  delete copy.authorizationRegistry.revision;
  if (
    enabled !== true ||
    registry.environment !== config.APP_IDENTITY_ENVIRONMENT ||
    digest(copy) !== registry.revision ||
    !source.endsWith("/" + registry.revision + ".yaml")
  )
    throw new Error("Snapshot integrity verification failed.");
  const auth = await checked(realmUrl + "/protocol/openid-connect/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.APP_KEYCLOAK_ADMIN_CLIENT_ID,
      client_secret: config.APP_KEYCLOAK_ADMIN_CLIENT_SECRET,
    }),
  });
  const headers = {
    Authorization: "Bearer " + auth.access_token,
    "Content-Type": "application/json",
  };
  const release = await acquireAuthorizationLock(
    config.APP_AUTHORIZATION_LOCK_FILE,
  );
  try {
    const current = await checked(realmUrl + "/tentu-authorization/snapshot", {
      headers,
    });
    if (current.revision !== registry.revision) {
      await status({
        state: "applying",
        desiredRevision: registry.revision,
        observedRevision: current.revision || null,
      });
      await checked(realmUrl + "/tentu-authorization/snapshot", {
        method: "PUT",
        headers,
        body: JSON.stringify(registry),
      });
    }
    const observed = await checked(realmUrl + "/tentu-authorization/snapshot", {
      headers,
    });
    if (
      observed.revision !== registry.revision ||
      observed.generation !== registry.generation ||
      JSON.stringify(observed.accessRules ?? []) !==
        JSON.stringify(registry.accessRules ?? []) ||
      JSON.stringify(observed.managedAccessClients ?? []) !==
        JSON.stringify(registry.managedAccessClients ?? []) ||
      JSON.stringify(observed.clientTokenScopes) !==
        JSON.stringify(registry.clientTokenScopes)
    )
      throw new Error("Applied registry verification failed.");
    // Writer releases only the verified complete snapshot, by atomic rename.
    await atomic(config.APP_AUTHORIZATION_CATALOGUE_PATH, {
      permissions: registry.permissions.map((p) => p.name),
      roles: snapshot.realm.roles.realm.map((r) => r.name),
    });
    await atomic(path.join(dir, "active-registry.json"), observed);
    await status({
      state: "applied",
      desiredRevision: registry.revision,
      observedRevision: observed.revision,
      generation: observed.generation,
      commitSha: head,
    });
    lastAppliedHead = head;
    lastVerification = Date.now();
    return observed;
  } finally {
    release();
  }
}
let previousError;
async function attempt() {
  try {
    await run();
    previousError = undefined;
    return true;
  } catch (error) {
    if (error.message !== previousError)
      console.error("Catalogue synchronization:", error.message);
    previousError = error.message;
    let existing = {};
    try {
      existing = JSON.parse(
        await readFile(config.APP_CATALOGUE_STATE_PATH, "utf8"),
      );
    } catch {}
    await status({ ...existing, state: "failed", detail: error.message });
    return false;
  }
}
if (process.argv.includes("--watch")) {
  while (true) {
    await attempt();
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(1000, Number(process.env.IDENTITY_SYNC_INTERVAL_MS) || 3000),
      ),
    );
  }
} else if (!(await attempt())) {
  process.exitCode = 1;
}
