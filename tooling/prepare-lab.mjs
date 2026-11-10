import {
  readFile,
  writeFile,
  mkdir,
  access,
  chmod,
  chown,
} from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { loadExternalSso } from "./external-sso.mjs";
import { configuration, digest } from "./identity-config.mjs";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const exists = async (file) =>
  access(file).then(
    () => true,
    () => false,
  );

/** Build the shared realm, browser clients and versioned authorization policy without writing or contacting services. */
export async function renderIdentityArtifacts({
  config: c,
  serviceSecrets,
  smtp,
  legalDocuments,
  users,
  serviceVersion = "0.7.2",
  registrationDefaultRole,
  syncManagement = false,
  identityProviders = [],
}) {
  for (const kind of ["admin", "account", "sync"]) {
    if (typeof serviceSecrets?.[kind] !== "string" || !serviceSecrets[kind])
      throw new Error(`The ${kind} service credential is missing.`);
  }
  const permissionsFile = parse(
    await readFile(
      path.join(source, "apps/admin-api/identity/permissions.yaml"),
      "utf8",
    ),
  );
  const permissions = [
    ...new Set(
      permissionsFile.spec.permissions
        .map((p) => p.id)
        .filter((p) => !p.includes("password") && !p.includes("groups:manage"))
        .concat(`admin-web:${c.environment}:access`),
    ),
  ].sort();
  const roles = [
    {
      name: "administrador",
      description: "Admin",
      permissions,
    },
    { name: "member", description: "SCORE member", permissions: [] },
    {
      name: "support",
      description: "Read-only user support",
      permissions: [
        `admin-web:${c.environment}:access`,
        "identity:users:view",
        "identity:roles:view",
        "identity:users:credentials:view",
      ],
    },
  ];
  const clientTokenScopes = [
    { clientId: "identity-admin-web", enabled: true, permissions },
    { clientId: "identity-account-web", enabled: true, permissions: [] },
  ];
  const permissionsByOwner = permissions.map((name) => ({
    name,
    description: name,
    owner: name.startsWith("admin-web:")
      ? "identity-admin-web"
      : "identity-admin-api",
  }));
  const snapshot = {
    permissions: {},
    realm: {
      name: c.realm,
      displayName: "SCORETech Identity",
      settings: { defaultRole: { name: "member" } },
      roles: {
        realm: roles.map((role) => ({
          name: role.name,
          description: role.description,
          ...(role.permissions.length
            ? { composite: true, composites: { realm: role.permissions } }
            : {}),
        })),
      },
      groups: [],
    },
    authorizationRegistry: {
      enabled: true,
      environment: c.environment,
      generation: 1,
      permissions: permissionsByOwner,
      roles,
      groups: [],
      clientTokenScopes,
    },
  };
  for (const permission of permissionsByOwner) {
    const [domain, ...parts] = permission.name.split(":");
    (snapshot.permissions[domain] ??= []).push({
      name: parts.join(":"),
      description: permission.description,
    });
  }
  snapshot.authorizationRegistry.revision = digest(snapshot);
  const registry = Object.fromEntries(
    Object.entries(snapshot.authorizationRegistry).filter(
      ([key]) => key !== "enabled",
    ),
  );
  const realm = JSON.parse(
    await readFile(path.join(source, "config/realm-template.json"), "utf8"),
  );
  realm.identityProviders = identityProviders;
  realm.realm = c.realm;
  realm.displayName = "SCORETech Identity";
  realm.webAuthnPolicyPasswordlessRpId = c.rpId;
  realm.attributes = {
    ...realm.attributes,
    "tentu.authorization.active": JSON.stringify(registry),
    "tentu.authorization.owned-roles": JSON.stringify(
      roles.map((role) => role.name),
    ),
  };
  if (registrationDefaultRole !== undefined)
    realm.attributes["tentu.registration.default-role"] =
      registrationDefaultRole;
  realm.roles.realm = [
    ...permissionsByOwner.map((permission) => ({
      name: permission.name,
      attributes: { "tentu.authorization.owner": [permission.owner] },
    })),
    ...snapshot.realm.roles.realm.map((role) => ({
      ...role,
      attributes: { "tentu.authorization.owner": ["authorization-registry"] },
    })),
  ];
  realm.scopeMappings = clientTokenScopes.map((scope) => ({
    client: scope.clientId,
    roles: scope.permissions,
  }));
  const audience = (name) => ({
    name: name + "-audience",
    protocol: "openid-connect",
    protocolMapper: "oidc-audience-mapper",
    config: {
      "included.custom.audience": name,
      "access.token.claim": "true",
      "id.token.claim": "false",
    },
  });
  const policy = {
    name: "SCORE authentication policy",
    protocol: "openid-connect",
    protocolMapper: "tentu-authentication-policy",
    config: {},
  };
  const rolesMapper = {
    name: "realm roles",
    protocol: "openid-connect",
    protocolMapper: "oidc-usermodel-realm-role-mapper",
    config: {
      "access.token.claim": "true",
      "claim.name": "realm_access.roles",
      "jsonType.label": "String",
      multivalued: "true",
      "id.token.claim": "false",
    },
  };
  const subjectMapper = {
    name: "subject",
    protocol: "openid-connect",
    protocolMapper: "oidc-sub-mapper",
    config: {
      "access.token.claim": "true",
      "introspection.token.claim": "true",
    },
  };
  realm.clients = [];
  realm.users = [];
  for (const kind of ["admin", "account"]) {
    const app = c[kind + "Url"];
    realm.clients.push({
      clientId: `identity-${kind}-web`,
      name: `SCORE ${kind === "admin" ? "Admin" : "Account"}`,
      enabled: true,
      protocol: "openid-connect",
      publicClient: true,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      implicitFlowEnabled: false,
      serviceAccountsEnabled: false,
      fullScopeAllowed: false,
      redirectUris: [
        app,
        app + "auth/callback",
        app + "auth/silent-callback",
        app + "auth/verification-callback",
      ],
      webOrigins: [c.origin],
      attributes: {
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": app,
      },
      defaultClientScopes: [
        "basic",
        "profile",
        "email",
        "roles",
        "web-origins",
      ],
      protocolMappers: [
        policy,
        rolesMapper,
        subjectMapper,
        audience(`identity-${kind}-api`),
        ...(kind === "admin" ? [audience("identity-account-api")] : []),
      ],
    });
    const clientId = `identity-${kind}-service`;
    realm.clients.push({
      clientId,
      enabled: true,
      protocol: "openid-connect",
      publicClient: false,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      secret: serviceSecrets[kind],
      protocolMappers: [
        audience("realm-management"),
        ...(kind === "admin" ? [audience("identity-provider")] : []),
      ],
    });
    realm.users.push({
      username: `service-account-${clientId}`,
      enabled: true,
      serviceAccountClientId: clientId,
      clientRoles: {
        "realm-management": [
          "view-users",
          "view-realm",
          "manage-users",
          "view-events",
        ],
      },
    });
  }
  realm.clients.push({
    clientId: "identity-config-sync",
    enabled: true,
    protocol: "openid-connect",
    publicClient: false,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    directAccessGrantsEnabled: false,
    secret: serviceSecrets.sync,
    protocolMappers: [
      audience("identity-provider"),
      ...(syncManagement ? [audience("realm-management")] : []),
    ],
  });
  if (c.environment === "local") {
    const account = realm.clients.find(
      (client) => client.clientId === "identity-account-web",
    );
    realm.clients.push({
      ...structuredClone(account),
      clientId: "lab-service-web",
      name: "SCORETech laboratory service",
      redirectUris: [c.root + "/lab-service/callback"],
      protocolMappers: [
        policy,
        rolesMapper,
        subjectMapper,
        audience("lab-service-web"),
      ],
    });
  }
  realm.users.push({
    username: "service-account-identity-config-sync",
    enabled: true,
    serviceAccountClientId: "identity-config-sync",
    ...(syncManagement
      ? {
          clientRoles: {
            "realm-management": [
              "view-realm",
              "manage-realm",
              "manage-identity-providers",
              "view-clients",
              "manage-clients",
            ],
          },
        }
      : {}),
  });
  realm.clients.push(
    { clientId: "account", enabled: false },
    { clientId: "account-console", enabled: false },
  );
  realm.users.push(...structuredClone(users));
  const actionNames = {
    "tentu-register-passkey": "Create passkey",
    CONFIGURE_TOTP: "Set up authenticator app",
    UPDATE_EMAIL: "Change email",
    "tentu-delete-credential": "Remove sign-in method",
  };
  for (const action of realm.requiredActions)
    if (actionNames[action.alias]) action.name = actionNames[action.alias];
  realm.smtpServer = structuredClone(smtp);
  for (const kind of ["terms", "privacy"]) {
    for (const field of ["url", "version", "digest"])
      realm.attributes[`tentu.legal.${kind}.${field}`] =
        legalDocuments[kind][field];
  }
  const revision = snapshot.authorizationRegistry.revision;
  const valueFile = `environments/identity/generated/revisions/${c.environment}/${revision}.yaml`;
  const files = {
    [valueFile]: stringify(snapshot),
    [`environments/identity/generated/environments/${c.environment}.yaml`]:
      stringify({
        environment: c.environment,
        generation: 1,
        revision,
        valueFile,
        contracts: {},
      }),
    "environments/identity/generated/operations/index.yaml": "[]\n",
  };
  for (const service of ["identity-config-sync", "identity-account-api"])
    files[`environments/${c.environment}/${service}.yaml`] = stringify({
      service,
      repo: "scoretech-identity",
      version: serviceVersion,
      namespace: "identity",
      enabled: true,
      valueFiles: [valueFile],
    });
  return { config: c, permissions, roles, realm, snapshot, registry, files };
}

/** Runtime JSON containing secrets is private to the API/provider UID inside containers. */
export async function secureRuntimeFile(
  file,
  contents,
  { publicFile = false } = {},
) {
  await writeFile(file, contents, { mode: publicFile ? 0o644 : 0o600 });
  await chmod(file, publicFile ? 0o644 : 0o600);
  if (process.getuid?.() === 0) await chown(file, 1000, 1000);
}
export async function runtimeDirectories(runtime, names) {
  await mkdir(runtime, { recursive: true });
  for (const name of names) {
    const dir = path.join(runtime, name);
    await mkdir(dir, { recursive: true });
    if (process.getuid?.() === 0) await chown(dir, 1000, 1000);
    await chmod(dir, name === "web" ? 0o755 : 0o700);
  }
}
export async function writePublicConfiguration(
  runtime,
  c,
  { lab = false } = {},
) {
  for (const kind of ["account", "admin"]) {
    const config = {
      ...c,
      kind,
      clientId: `identity-${kind}-web`,
      baseUrl: c[kind + "Url"],
      accountApiUrl: c.root + "/api/account/v1/account",
      adminApiUrl: c.root + "/api/admin/v1",
      lab,
    };
    await secureRuntimeFile(
      path.join(runtime, `web/${kind}.js`),
      `window.__SCORE_CONFIG__ = ${JSON.stringify(config)};\n`,
      { publicFile: true },
    );
  }
}

export async function prepareLaboratory(env = process.env) {
  const runtime = env.IDENTITY_RUNTIME_DIR || path.join(source, ".lab");
  const c = configuration(env);
  if (c.environment !== "local")
    throw new Error("Lab preparation is restricted to the local environment.");
  // These registration references are explicit local fixtures, never production legal documents.
  const legalDocuments = Object.fromEntries(
    ["terms", "privacy"].map((kind) => {
      const body = `Local SCORETech Identity ${kind} fixture. For testing only.`;
      return [
        kind,
        {
          url: c.root + "/legal/" + kind,
          version: "lab-v1",
          digest: "sha256:" + digest(body),
        },
      ];
    }),
  );
  const artifacts = await renderIdentityArtifacts({
    config: c,
    identityProviders: await loadExternalSso(runtime, true),
    registrationDefaultRole: "member",
    serviceSecrets: {
      admin: "fixture-local-admin-service",
      account: "fixture-local-account-service",
      sync: "fixture-local-config-sync",
    },
    smtp: {
      host: "mail",
      port: "1025",
      from: "identity@example.invalid",
      fromDisplayName: "SCORETech Identity",
      auth: "false",
      ssl: "false",
      starttls: "false",
    },
    legalDocuments,
    users: [
      ["admin-score@example.invalid", "Admin", "administrador"],
      ["person@example.invalid", "Researcher", "member"],
      ["support@example.invalid", "Support", "support"],
    ].map(([email, firstName, role]) => ({
      username: email,
      email,
      firstName,
      lastName: "SCORE",
      enabled: true,
      emailVerified: true,
      realmRoles: [role],
    })),
  });
  await runtimeDirectories(runtime, [
    "import",
    "catalogue",
    "web",
    "keys",
    "github",
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
  const stateFile = path.join(runtime, "github/state.json");
  if (!(await exists(stateFile))) {
    const sha = digest(artifacts.files).slice(0, 40);
    await secureRuntimeFile(
      stateFile,
      JSON.stringify({
        head: sha,
        commits: { [sha]: { tree: sha, parents: [] } },
        trees: { [sha]: artifacts.files },
      }),
    );
  }
  if (!(await exists(path.join(runtime, "catalogue/catalogue.json")))) {
    await secureRuntimeFile(
      path.join(runtime, "catalogue/catalogue.json"),
      JSON.stringify({
        permissions: artifacts.permissions,
        roles: artifacts.roles.map((role) => role.name),
      }),
    );
    await secureRuntimeFile(
      path.join(runtime, "catalogue/active-registry.json"),
      JSON.stringify(artifacts.registry),
    );
  }
  const keyFile = path.join(runtime, "keys/github.pem");
  if (!(await exists(keyFile))) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await secureRuntimeFile(
      keyFile,
      privateKey.export({ type: "pkcs8", format: "pem" }),
    );
  }
  // Tighten an existing fixture key too; never make it world-readable for the API.
  await chmod(keyFile, 0o600);
  if (process.getuid?.() === 0) await chown(keyFile, 1000, 1000);
  await writePublicConfiguration(runtime, c, { lab: true });
  console.log(
    "Prepared isolated SCORETech Identity laboratory. No external services were contacted.",
  );
  return artifacts;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await prepareLaboratory();
