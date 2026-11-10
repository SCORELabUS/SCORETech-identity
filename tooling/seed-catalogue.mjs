import { readFile } from "node:fs/promises";
import { loadConfig } from "../apps/admin-api/dist/main/config/app-config.js";
import { Github } from "../apps/admin-api/dist/main/modules/catalogue/github.js";
const config = loadConfig();
if (config.APP_IDENTITY_ENVIRONMENT === "local")
  throw new Error("Local catalogue is initialized by the lab generator.");
const github = new Github(config);
const files = JSON.parse(
  await readFile(
    (process.env.IDENTITY_RUNTIME_DIR || "/runtime") + "/catalogue-seed.json",
    "utf8",
  ),
);
let head;
try {
  head = await github.head();
} catch (error) {
  if (error.status !== 404) throw error;
  const main = await github.request("/git/ref/heads/main");
  if (!/^[a-f0-9]{40}$/.test(main.object?.sha || ""))
    throw new Error("Cannot identify the trusted initial Git revision.");
  await github.request("/git/refs", "POST", {
    ref: "refs/heads/" + config.APP_CATALOGUE_BRANCH,
    sha: main.object.sha,
  });
  head = main.object.sha;
}
try {
  await github.file(
    `environments/${config.APP_IDENTITY_ENVIRONMENT}/identity-config-sync.yaml`,
    head,
  );
  console.log("Catalogue already exists; initial seed left unchanged.");
} catch (error) {
  if (error.status !== 404) throw error;
  await github.commit(
    head,
    Object.entries(files).map(([path, content]) => ({ path, content })),
    `Initialize SCORETech Identity catalogue for ${config.APP_IDENTITY_ENVIRONMENT}`,
  );
  console.log(
    "Initial catalogue published. Synchronization verifies its application separately.",
  );
}
