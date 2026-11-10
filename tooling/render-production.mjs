import { legalReferences } from "./legal-documents.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadExternalSso } from "./external-sso.mjs";
import { configuration } from "./identity-config.mjs";
import {
  exists,
  renderIdentityArtifacts,
  runtimeDirectories,
  secureRuntimeFile,
  writePublicConfiguration,
} from "./prepare-lab.mjs";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for production rendering.`);
  return value;
}
async function readSecret(env, name) {
  const file = required(env, name);
  let value;
  try {
    value = (await readFile(file, "utf8")).trim();
  } catch {
    throw new Error(`Unable to read ${name}.`);
  }
  if (!value || /[\r\n\0]/.test(value) || value.startsWith("fixture-local-"))
    throw new Error(`${name} must contain a non-fixture service credential.`);
  return value;
}
function email(value, name) {
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ||
    value.toLowerCase().endsWith(".invalid")
  )
    throw new Error(`${name} must be a valid configured email address.`);
  return value;
}
async function emailConfiguration(env) {
  const sender = {
    from: email(required(env, "BREVO_SENDER_EMAIL"), "BREVO_SENDER_EMAIL"),
    fromDisplayName: env.BREVO_SENDER_NAME?.trim() || "SCORETech Identity",
  };
  const transport = env.BREVO_EMAIL_TRANSPORT?.trim() || "smtp";
  if (transport === "api") return sender;
  if (transport !== "smtp")
    throw new Error("BREVO_EMAIL_TRANSPORT must be smtp or api.");
  const port = env.BREVO_SMTP_PORT?.trim() || "587";
  if (!["587", "2525", "465"].includes(port))
    throw new Error("BREVO_SMTP_PORT must be 587, 2525 or 465.");
  const [user, password] = await Promise.all([
    readSecret(env, "BREVO_SMTP_LOGIN_FILE"),
    readSecret(env, "BREVO_SMTP_KEY_FILE"),
  ]);
  return {
    ...sender,
    host: "smtp-relay.brevo.com",
    port,
    user,
    password,
    auth: "true",
    ssl: port === "465" ? "true" : "false",
    starttls: port === "465" ? "false" : "true",
  };
}
/** Render deployment inputs only. This never connects to Keycloak, GitHub, Brevo or the published documents. */
export async function renderProduction(env = process.env) {
  required(env, "IDENTITY_PUBLIC_ORIGIN");
  const runtime = path.resolve(required(env, "IDENTITY_RUNTIME_DIR"));
  const rpId = required(env, "IDENTITY_WEBAUTHN_RP_ID");
  const c = configuration({
    ...env,
    IDENTITY_ENVIRONMENT: env.IDENTITY_ENVIRONMENT || "production",
  });
  if (c.environment === "local")
    throw new Error(
      "Production rendering does not accept the local environment.",
    );
  const hostname = new URL(c.origin).hostname;
  if (
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(rpId) ||
    !rpId.includes(".") ||
    !(hostname === rpId || hostname.endsWith("." + rpId))
  )
    throw new Error(
      "IDENTITY_WEBAUTHN_RP_ID must be the public hostname or an explicitly selected parent domain.",
    );
  const bootstrapEmail = email(
    required(env, "IDENTITY_BOOTSTRAP_EMAIL"),
    "IDENTITY_BOOTSTRAP_EMAIL",
  );
  const legalDocuments = legalReferences(c.origin);
  const [admin, account, sync, smtp] = await Promise.all([
    readSecret(env, "IDENTITY_ADMIN_SECRET_FILE"),
    readSecret(env, "IDENTITY_ACCOUNT_SECRET_FILE"),
    readSecret(env, "IDENTITY_SYNC_SECRET_FILE"),
    emailConfiguration(env),
  ]);
  if (new Set([admin, account, sync]).size !== 3)
    throw new Error("Identity service clients require distinct credentials.");
  if (
    (await exists(path.join(runtime, "github/state.json"))) ||
    (await exists(path.join(runtime, "keys/github.pem")))
  )
    throw new Error(
      "The production runtime directory contains laboratory fixtures. Select a separate directory.",
    );
  const artifacts = await renderIdentityArtifacts({
    config: c,
    identityProviders: await loadExternalSso(runtime),
    serviceSecrets: { admin, account, sync },
    smtp,
    legalDocuments,
    // The first operator proves their email through OTP and enrols a passkey in the normal flow.
    // No password, verified-email claim or existing credential is fabricated here.
    users: [
      {
        username: bootstrapEmail,
        email: bootstrapEmail,
        enabled: true,
        emailVerified: false,
        realmRoles: ["administrador"],
      },
    ],
    registrationDefaultRole: "member",
    serviceVersion: "0.1.0",
    // Realm/profile/callback reconciliation is a deployment capability, never a browser credential.
    syncManagement: true,
  });
  artifacts.realm.sslRequired = "external";
  await runtimeDirectories(runtime, [
    "import",
    "catalogue",
    "web",
    "coordination",
  ]);
  if (!(await exists(path.join(runtime, "coordination/authorization.lock"))))
    await secureRuntimeFile(
      path.join(runtime, "coordination/authorization.lock"),
      "",
    );
  await secureRuntimeFile(
    path.join(runtime, "import/score-realm.json"),
    JSON.stringify(artifacts.realm, null, 2) + "\n",
  );
  await secureRuntimeFile(
    path.join(runtime, "catalogue-seed.json"),
    JSON.stringify(artifacts.files, null, 2) + "\n",
  );
  // Only the synchronizer may release a verified applied projection. Never replace an existing one.
  const projection = path.join(runtime, "catalogue/catalogue.json");
  if (!(await exists(projection)))
    await secureRuntimeFile(
      projection,
      JSON.stringify({ permissions: [], roles: [] }) + "\n",
    );
  const stateFile = path.join(runtime, "catalogue/apply-status.json");
  if (!(await exists(stateFile)))
    await secureRuntimeFile(
      stateFile,
      JSON.stringify({
        state: "pending",
        desiredRevision: artifacts.registry.revision,
        observedRevision: null,
      }) + "\n",
    );
  await writePublicConfiguration(runtime, c, { lab: false });
  console.log(
    "Rendered SCORETech Identity deployment inputs. No external services were contacted.",
  );
  return artifacts;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await renderProduction();
