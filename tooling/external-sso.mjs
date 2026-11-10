import { readFile } from "node:fs/promises";

function publicUrl(value, name, local) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== "https:" &&
      !(
        local &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ))
  )
    throw new Error(
      `${name} must be an HTTPS URL without credentials, query or fragment.`,
    );
  return url.href.replace(/\/$/, "");
}
export async function loadExternalSso(runtime, local = false) {
  let input;
  try {
    input = JSON.parse(await readFile(runtime + "/external-sso.json", "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error("Invalid external-sso.json.");
  }
  return externalProviders(input, local);
}
export function externalProviders(input, local = false) {
  const common = {
    enabled: true,
    trustEmail: false,
    storeToken: false,
    linkOnly: false,
    firstBrokerLoginFlowAlias: "score-first-broker-login-v1",
    postBrokerLoginFlowAlias: "score-post-broker-login",
  };
  const providers = [];
  if (input.google?.enabled) {
    if (!input.google.clientId?.trim() || !input.google.clientSecret?.trim())
      throw new Error(
        "Enabled Google SSO requires clientId and clientSecret in external-sso.json.",
      );
    providers.push({
      ...common,
      alias: "google",
      providerId: "google",
      displayName: "Google",
      config: {
        clientId: input.google.clientId.trim(),
        clientSecret: input.google.clientSecret.trim(),
        defaultScope: "openid email profile",
        syncMode: "IMPORT",
        guiOrder: "10",
      },
    });
  }
  if (input.us?.enabled)
    providers.push({
      ...common,
      alias: "us-sso",
      providerId: "score-us-cas",
      displayName: "Universidad de Sevilla",
      config: {
        casUrl: publicUrl(
          input.us.casUrl || "https://sso.us.es/CAS",
          "US CAS URL",
          local,
        ),
        ...(input.us.callbackUrl
          ? {
              callbackUrl: publicUrl(
                input.us.callbackUrl,
                "US callback URL",
                local,
              ),
            }
          : {}),
        syncMode: "IMPORT",
        guiOrder: "20",
      },
    });
  return providers;
}

// Reconcile owned providers and flows without replacing unrelated realm state.
export async function reconcileExternalSso(call, realm) {
  for (const flow of realm.authenticationFlows.filter(
    (f) => f.alias.startsWith("score-") && f.topLevel,
  )) {
    const flows = await call("/authentication/flows");
    if (!flows.some((f) => f.alias === flow.alias)) {
      await call("/authentication/flows", "POST", {
        ...flow,
        authenticationExecutions: undefined,
      });
    }
    await addExecutions(
      call,
      flow.alias,
      flow.authenticationExecutions || [],
      realm,
    );
  }
  const actions = await call("/authentication/required-actions");
  for (const action of (realm.requiredActions || []).filter((a) =>
    [
      "VERIFY_EMAIL",
      "idp_link",
      "score-unlink-identity",
      "score-delete-account",
    ].includes(a.alias),
  )) {
    if (!actions.some((a) => a.alias === action.alias))
      await call("/authentication/register-required-action", "POST", {
        providerId: action.providerId,
        name: action.name,
      });
    await call(
      "/authentication/required-actions/" + action.alias,
      "PUT",
      action,
    );
  }
  const existing = await call("/identity-provider/instances");
  for (const alias of ["google", "us-sso"]) {
    const desired = realm.identityProviders?.find((p) => p.alias === alias);
    const previous = existing.find((p) => p.alias === alias);
    if (desired)
      await call(
        "/identity-provider/instances" + (previous ? "/" + alias : ""),
        previous ? "PUT" : "POST",
        desired,
      );
    else if (previous)
      await call("/identity-provider/instances/" + alias, "PUT", {
        ...previous,
        enabled: false,
      });
  }
}
async function addExecutions(call, alias, executions, realm) {
  const path = "/authentication/flows/" + encodeURIComponent(alias);
  for (const execution of executions) {
    const matches = (e) =>
      execution.authenticatorFlow
        ? e.displayName === execution.flowAlias
        : e.providerId === execution.authenticator;
    const previous = (await call(path + "/executions")).find(matches);
    if (execution.authenticatorFlow) {
      const sub = realm.authenticationFlows.find(
        (f) => f.alias === execution.flowAlias,
      );
      if (!previous)
        await call(path + "/executions/flow", "POST", {
          alias: sub.alias,
          type: "basic-flow",
          description: sub.description || "",
        });
      await addExecutions(call, sub.alias, sub.authenticationExecutions, realm);
    } else if (!previous)
      await call(path + "/executions/execution", "POST", {
        provider: execution.authenticator,
      });
    const added = (await call(path + "/executions")).find((e) =>
      execution.authenticatorFlow
        ? e.displayName === execution.flowAlias
        : e.providerId === execution.authenticator,
    );
    if (!added)
      throw new Error("SSO authentication execution was not created.");
    await call(path + "/executions", "PUT", {
      ...added,
      requirement: execution.requirement,
    });
  }
}

export async function reconcileAccountLinking(call) {
  const [account] = await call("/clients?clientId=account");
  const [web] = await call("/clients?clientId=identity-account-web");
  if (!account || !web) throw new Error("Account linking clients are missing.");
  const roles = await call("/clients/" + account.id + "/roles");
  // Native Keycloak checks manage-account before the narrower links role.
  // Keep that role defined, but never grant or scope it to the web client.
  for (const name of ["manage-account", "manage-account-links"])
    if (!roles.some((r) => r.name === name))
      await call("/clients/" + account.id + "/roles", "POST", {
        name,
        description:
          name === "manage-account-links"
            ? "Manage own external sign-in connections"
            : "Native account role (not granted)",
      });
  const role = await call(
    "/clients/" + account.id + "/roles/manage-account-links",
  );
  const realm = await call("");
  await call("/roles-by-id/" + realm.defaultRole.id + "/composites", "POST", [
    role,
  ]);
  await call(
    "/clients/" + web.id + "/scope-mappings/clients/" + account.id,
    "POST",
    [role],
  );
}
