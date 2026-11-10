import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { digest } from "./identity-config.mjs";
function verifySnapshot(snapshot, revision) {
  const copy = structuredClone(snapshot);
  delete copy.authorizationRegistry.revision;
  if (
    snapshot.authorizationRegistry.revision !== revision ||
    digest(copy) !== revision
  )
    throw new Error(
      "A legacy catalogue snapshot failed integrity verification; nothing was migrated.",
    );
}
import {
  ProviderCatalogueClient,
  secretEnvironment,
} from "../packages/identity-internal/dist/index.js";
import { readCatalogue } from "../apps/admin-api/dist/main/modules/catalogue/catalogue-model.js";
const env = secretEnvironment(process.env);
const client = new ProviderCatalogueClient(env);
const state = await client.request();
if (state.initialized) {
  console.log(
    "Database catalogue already initialized; roles, permissions and history retained.",
  );
} else {
  let roleNames = state.catalogue.roles.map((role) => role.name);
  const history = [];
  let legacy;
  try {
    legacy = JSON.parse(
      await readFile(
        path.join(env.IDENTITY_RUNTIME_DIR || "/runtime", "github/state.json"),
        "utf8",
      ),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (legacy) {
    const tree = legacy.trees[legacy.commits[legacy.head]?.tree];
    if (!tree)
      throw new Error(
        "The legacy catalogue commit has no tree; migration was not applied.",
      );
    const environment = state.registry.environment;
    const overlay = parse(
      tree[`environments/${environment}/identity-config-sync.yaml`],
    );
    const snapshot = parse(tree[overlay.valueFiles[0]]);
    if (snapshot.authorizationRegistry.revision !== state.registry.revision)
      throw new Error(
        "Legacy catalogue and database differ. Complete or recover the previous publication before migrating; no roles were overwritten.",
      );
    verifySnapshot(snapshot, state.registry.revision);
    roleNames = readCatalogue(snapshot).roles.map((role) => role.name);
    const index =
      tree["environments/identity/generated/operations/index.yaml"] ||
      tree["environments/identity/operations/index.yaml"];
    for (const id of index ? parse(index).slice(0, 100) : []) {
      const operation = parse(
        tree[`environments/identity/generated/operations/${id}.yaml`] ||
          tree[`environments/identity/operations/${id}.yaml`],
      );
      const revision = operation.revisions[environment];
      if (!revision) continue;
      const text =
        tree[
          `environments/identity/generated/revisions/${environment}/${revision}.yaml`
        ] ||
        tree[`environments/identity/revisions/${environment}/${revision}.yaml`];
      if (!text)
        throw new Error(
          "A legacy audit snapshot is missing; the migration was not applied.",
        );
      verifySnapshot(parse(text), revision);
      history.push({
        id: revision,
        createdAt: operation.createdAt,
        actor: operation.actor,
        reason: operation.reason,
        type: operation.type,
        catalogue: readCatalogue(text),
      });
    }
  }
  await client.request("/initialize", "POST", {
    baseRevision: state.registry.revision,
    roleNames,
    history,
  });
  console.log(
    "Database catalogue initialized. Existing identities, applications and authorization retained.",
  );
}
