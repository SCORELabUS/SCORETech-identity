import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const identityRequire = createRequire(
  new URL("../../packages/identity-internal/package.json", import.meta.url),
);
const { createRemoteJWKSet, jwtVerify } = identityRequire("jose");
const appliedMessage =
  "The change has been applied and verified. Your session permissions are up to date.";

/** Uses only the two real browser sessions and the public OIDC protocol. */
export async function verifyAccessPolicy({
  admin,
  member,
  origin,
  run,
  artifacts,
  mark,
}) {
  assert.equal(
    new URL(origin).hostname,
    "localhost",
    "Access-policy E2E requires the isolated localhost lab.",
  );
  assert.equal(
    new URL(origin).protocol,
    "http:",
    "Access-policy E2E requires the local HTTP laboratory.",
  );
  assert.match(
    String(run),
    /^\d+$/,
    "Use the triplet's unique numeric run identifier.",
  );
  const permission = `e2e-service:admin-${run}`;
  const ruleId = `e2e-service-${run}`;
  const role = `e2e-reader-${run}`;
  const roleDescription = `E2E directory reader ${run}`;
  const clientId = "lab-service-web";
  const callback = origin + "/identity/lab-service/callback";
  let ruleSaved = false;
  let granted = false;
  let proof;
  let phase = "reading the existing catalogue";

  async function readAdmin(path) {
    const result = await admin.evaluate(async (relative) => {
      const config = window.__SCORE_CONFIG__;
      if (!config?.adminApiUrl || !config.issuer || !config.clientId)
        throw new Error("The signed-in Admin public configuration is missing.");
      let user;
      try {
        user = JSON.parse(
          sessionStorage.getItem(
            `score.user.user:${config.issuer}:${config.clientId}`,
          ) || "null",
        );
      } catch {
        throw new Error("The Admin browser session is unreadable.");
      }
      if (!user?.access_token)
        throw new Error("A signed-in Admin browser session is required.");
      const response = await fetch(config.adminApiUrl + relative, {
        headers: { Authorization: "Bearer " + user.access_token },
        cache: "no-store",
      });
      if (!response.ok)
        return { status: response.status, environment: config.environment };
      return {
        status: response.status,
        environment: config.environment,
        issuer: config.issuer,
        data: await response.json(),
      };
    }, path);
    assert.equal(
      result.status,
      200,
      `Access-policy proof could not read Admin ${path}.`,
    );
    return result;
  }

  // Legacy catalogue policies remain a backend compatibility contract; their retired UI is not used.
  async function publishLegacyRules(accessRules, reason) {
    const { data, environment } = await readAdmin("/catalogue");
    const response = await admin.evaluate(
      async ({ baseSha, catalogue, environment, reason }) => {
        const c = window.__SCORE_CONFIG__;
        const user = JSON.parse(
          sessionStorage.getItem(`score.user.user:${c.issuer}:${c.clientId}`) ||
            "null",
        );
        const r = await fetch(c.adminApiUrl + "/catalogue/revisions", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + user.access_token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            baseSha,
            catalogue,
            sourceEnvironment: environment,
            environments: [environment],
            reason,
          }),
        });
        return { status: r.status, data: await r.json() };
      },
      {
        baseSha: data.baseSha,
        catalogue: { ...data.catalogue, accessRules },
        environment,
        reason,
      },
    );
    assert.equal(
      response.status,
      201,
      "Legacy policy compatibility publication failed.",
    );
    if (accessRules.some((rule) => rule.id === ruleId)) ruleSaved = true;
    await waitApplied(response.data.revision.revisions[environment]);
  }

  async function waitApplied(revision) {
    for (let attempt = 0; attempt < 65; attempt++) {
      const { data, environment } = await readAdmin("/catalogue/environments");
      const state = data.environments.find(
        (item) => item.environment === environment,
      );
      assert.notEqual(
        state?.state,
        "failed",
        "The access-policy catalogue revision failed to apply.",
      );
      if (state?.state === "applied" && state.observedRevision === revision)
        return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      "The exact access-policy revision was not applied within 65 seconds.",
    );
  }

  async function publish(button, { notice = false, saved } = {}) {
    const published = admin.waitForResponse(
      (response) =>
        response.url().endsWith("/catalogue/revisions") &&
        response.request().method() === "POST",
    );
    await button.click();
    const response = await published;
    assert.equal(
      response.status(),
      201,
      "The access-policy UI publication was rejected.",
    );
    const result = await response.json();
    const revision = result.revision?.revisions?.local;
    assert.match(
      revision || "",
      /^[a-f0-9]{64}$/,
      "The publication did not return its local immutable revision.",
    );
    saved?.();
    await waitApplied(revision);
    if (notice)
      await admin
        .getByText(appliedMessage, { exact: true })
        .waitFor({ timeout: 65_000 });
    await admin.getByRole("dialog").waitFor({ state: "hidden" });
  }

  async function changeReaderPermission(checked) {
    await admin.getByRole("button", { name: "Roles", exact: true }).click();
    await admin
      .getByRole("textbox", { name: "Search roles", exact: true })
      .fill(roleDescription);
    const row = admin
      .getByRole("table", { name: "Role catalogue", exact: true })
      .locator("tbody tr")
      .filter({ hasText: roleDescription });
    await row.getByRole("button", { name: "Edit role", exact: true }).click();
    const dialog = admin.getByRole("dialog");
    assert.equal(
      await dialog.getByLabel("Role identifier", { exact: true }).inputValue(),
      role,
      "The access proof must edit only its existing run-owned reader role.",
    );
    await dialog.getByLabel(permission, { exact: false }).setChecked(checked);
    await dialog
      .getByRole("button", { name: "Review changes", exact: true })
      .click();
    await dialog
      .getByLabel("Reason for this change", { exact: true })
      .fill(
        checked
          ? "Verify a real member receives the laboratory service permission."
          : "Verify live service access and refresh-token revocation after removing permission.",
      );
    await publish(
      dialog.getByRole("button", { name: "Publish changes", exact: true }),
      {
        saved: () => {
          granted = checked;
        },
      },
    );
  }

  async function authorize(issuer, allowed) {
    const page = await member.context().newPage();
    const ssoBefore = (await member.context().cookies(issuer + "/")).some(
      (cookie) =>
        cookie.name === "KEYCLOAK_IDENTITY" ||
        cookie.name === "KEYCLOAK_IDENTITY_LEGACY",
    );
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    const url = new URL(issuer + "/protocol/openid-connect/auth");
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callback,
      response_type: "code",
      scope: "openid profile email",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state,
      nonce: randomBytes(24).toString("base64url"),
    }).toString();
    let returned;
    try {
      await page.route(
        (target) =>
          target.origin === origin &&
          target.pathname === "/identity/lab-service/callback",
        async (route) => {
          const target = new URL(route.request().url());
          if (
            target.origin !== origin ||
            target.pathname !== "/identity/lab-service/callback"
          ) {
            await route.abort();
            return;
          }
          returned = target.searchParams;
          await route.fulfill({
            status: 200,
            contentType: "text/plain",
            body: "SCORE laboratory OIDC callback captured.",
          });
        },
      );
      let response;
      try {
        response = await page.goto(url.href, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      } catch {
        throw new Error(
          "The isolated service OIDC navigation did not complete.",
        );
      }
      // Chromium's Playwright routing skips requests that follow a server redirect.
      // The lab has no callback application, so its terminal 404 still carries the
      // genuine OIDC response. Capture only this exact callback; never log its URL.
      const terminal = new URL(page.url());
      if (
        !returned &&
        terminal.origin === origin &&
        terminal.pathname === "/identity/lab-service/callback"
      )
        returned = terminal.searchParams;
      if (returned)
        assert.equal(
          returned.get("state"),
          state,
          "The service authorization response lost its state binding.",
        );
      if (!allowed) {
        assert.ok(
          !returned?.get("code"),
          "The member obtained a service authorization code without its required permission.",
        );
        assert.ok(
          returned?.get("error") === "access_denied" ||
            response?.status() === 403,
          `Expected permission denial through existing SSO (HTTP ${response?.status()}, OAuth error ${returned?.get("error") || "none"}), rather than a missing session or server error.`,
        );
        return;
      }
      if (!returned?.get("code") || returned.get("error")) {
        const screen = await page.evaluate(() => ({
          path: location.pathname,
          headings: [...document.querySelectorAll("#kc-page-title,h1,h2")]
            .slice(0, 4)
            .map((heading) =>
              (heading.textContent || "")
                .trim()
                .replace(/\s+/g, " ")
                .replace(
                  /[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/g,
                  "[redacted]",
                )
                .slice(0, 140),
            ),
          emailForm: Boolean(document.querySelector("#email")),
          codeForm: Boolean(document.querySelector("#code")),
          passkeyForm: Boolean(
            document.querySelector(
              "#kc-form-webauthn,#authenticateWebAuthnButton",
            ),
          ),
        }));
        const rawError = returned?.get("error") || "none";
        const diagnostic = {
          expected: "authorized",
          httpStatus: response?.status() ?? null,
          oauthError: /^[a-z_]{1,64}$/.test(rawError)
            ? rawError
            : "unrecognized",
          ssoIdentityCookieBefore: ssoBefore,
          ssoIdentityCookieAfter: (
            await member.context().cookies(issuer + "/")
          ).some(
            (cookie) =>
              cookie.name === "KEYCLOAK_IDENTITY" ||
              cookie.name === "KEYCLOAK_IDENTITY_LEGACY",
          ),
          ...screen,
        };
        await writeFile(
          artifacts + "/access-policy-oauth-diagnostic.json",
          JSON.stringify(diagnostic, null, 2) + "\n",
        );
        await page.screenshot({
          path: artifacts + "/failure-service-authorization.png",
          fullPage: true,
        });
        throw new Error(
          "The granted member did not receive a service authorization code: " +
            JSON.stringify(diagnostic),
        );
      }
      return { code: returned.get("code"), verifier };
    } finally {
      await page.close();
    }
  }

  async function tokenRequest(issuer, parameters) {
    try {
      return await fetch(issuer + "/protocol/openid-connect/token", {
        method: "POST",
        body: new URLSearchParams({ client_id: clientId, ...parameters }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(
        "The laboratory service token endpoint could not be reached.",
      );
    }
  }

  async function removeOwnedRule() {
    const { data } = await readAdmin("/catalogue");
    const current = data.catalogue.accessRules?.find(
      (item) => item.id === ruleId,
    );
    if (!current) {
      assert.ok(
        !data.catalogue.accessRules?.some((item) => item.clientId === clientId),
        "Cleanup refused to replace a different laboratory service rule.",
      );
      ruleSaved = false;
      return;
    }
    assert.equal(
      current.clientId,
      clientId,
      "Cleanup refused a changed access-rule owner.",
    );
    assert.equal(
      current.origin,
      origin,
      "Cleanup refused a changed access-rule origin.",
    );
    assert.deepEqual(
      current.requiredPermissions,
      [permission],
      "Cleanup refused a changed access-rule policy.",
    );
    await publishLegacyRules(
      data.catalogue.accessRules.filter((item) => item.id !== ruleId),
      "Remove only the temporary run-owned legacy compatibility policy after verification.",
    );
    const restored = await readAdmin("/catalogue");
    assert.ok(
      !restored.data.catalogue.accessRules?.some(
        (item) => item.clientId === clientId,
      ),
      "The temporary laboratory client policy was not removed.",
    );
    ruleSaved = false;
  }

  try {
    const initial = await readAdmin("/catalogue");
    assert.equal(
      initial.environment,
      "local",
      "Access-policy proof must use the local environment.",
    );
    assert.equal(
      new URL(initial.issuer).origin,
      origin,
      "OIDC must remain in the isolated laboratory.",
    );
    assert.ok(
      !initial.data.catalogue.accessRules?.some(
        (item) => item.clientId === clientId,
      ),
      "The laboratory service already has an access rule; refusing to replace it.",
    );
    assert.ok(
      initial.data.catalogue.roles.some(
        (item) => item.name === role && item.description === roleDescription,
      ),
      "The triplet's existing delegated reader role is required.",
    );
    assert.ok(
      !initial.data.catalogue.permissions.some(
        (item) => item.name === permission,
      ),
      "The run-owned permission already exists; choose a new triplet run.",
    );
    const subject = await member.evaluate(() => {
      const config = window.__SCORE_CONFIG__;
      try {
        return JSON.parse(
          sessionStorage.getItem(
            `score.user.user:${config.issuer}:${config.clientId}`,
          ) || "null",
        )?.profile?.sub;
      } catch {
        return null;
      }
    });
    assert.equal(
      typeof subject,
      "string",
      "The authenticated member subject is required.",
    );

    phase = "creating a service permission through Admin";
    await admin
      .getByRole("button", { name: "Permissions", exact: true })
      .click();
    await admin
      .getByRole("button", { name: "Create permission", exact: true })
      .click();
    let dialog = admin.getByRole("dialog");
    await dialog
      .getByLabel("Permission name", { exact: true })
      .fill(permission);
    await dialog
      .getByLabel("Description", { exact: true })
      .fill(`E2E laboratory service access ${run}`);
    await dialog
      .getByLabel("Reason for this change", { exact: true })
      .fill(
        "Declare an additive service permission through the real Admin interface.",
      );
    await publish(
      dialog.getByRole("button", { name: "Create permission", exact: true }),
      { notice: true },
    );
    mark(
      "Service permission creation and verified provider application passed.",
    );

    phase = "checking legacy exact-origin policy compatibility";
    const beforeRule = await readAdmin("/catalogue");
    await publishLegacyRules(
      [
        ...(beforeRule.data.catalogue.accessRules ?? []),
        { id: ruleId, clientId, origin, requiredPermissions: [permission] },
      ],
      "Verify legacy catalogue admission without exposing its retired editor.",
    );
    ruleSaved = true;
    const issuer = initial.issuer;
    phase = "checking service denial before a grant";
    await authorize(issuer, false);
    mark(
      "The exact-origin service rule denied an existing SSO member without its required permission.",
    );

    const protectedRole = (
      await readAdmin("/catalogue")
    ).data.catalogue.roles.find((item) => item.name === "administrador");
    assert.ok(
      protectedRole?.permissions.includes(permission),
      "Admin must automatically inherit every newly declared permission.",
    );
    phase = "granting the permission through the existing reader role";
    await changeReaderPermission(true);
    phase = "exchanging a real PKCE authorization code";
    const authorization = await authorize(issuer, true);
    const exchanged = await tokenRequest(issuer, {
      grant_type: "authorization_code",
      redirect_uri: callback,
      code: authorization.code,
      code_verifier: authorization.verifier,
    });
    assert.equal(
      exchanged.status,
      200,
      "The legitimate service authorization code exchange was rejected.",
    );
    let tokens;
    try {
      tokens = await exchanged.json();
    } catch {
      throw new Error("The service token endpoint returned invalid JSON.");
    }
    assert.equal(
      typeof tokens.access_token,
      "string",
      "The service access token is missing.",
    );
    assert.equal(
      typeof tokens.refresh_token,
      "string",
      "The service refresh token is missing.",
    );
    let verified;
    try {
      verified = await jwtVerify(
        tokens.access_token,
        createRemoteJWKSet(new URL(issuer + "/protocol/openid-connect/certs")),
        { algorithms: ["RS256"], issuer, audience: clientId },
      );
    } catch {
      throw new Error(
        "The service token failed RS256 signature, issuer or audience verification.",
      );
    }
    assert.equal(verified.protectedHeader.alg, "RS256");
    assert.equal(
      verified.payload.sub,
      subject,
      "The service token belongs to a different member.",
    );
    const roles = verified.payload.realm_access?.roles;
    assert.deepEqual(
      roles,
      [permission],
      "The service token must contain only its required atomic permission.",
    );
    assert.ok(
      !roles.some(
        (value) =>
          value.startsWith("identity:") || value.startsWith("admin-web:"),
      ),
      "Identity administration permissions leaked into a service token.",
    );
    mark(
      "Real SSO + PKCE exchange, RS256/JWKS verification and isolated service token scope passed.",
    );

    phase = "revoking the role permission and checking refresh rejection";
    await changeReaderPermission(false);
    const refreshed = await tokenRequest(issuer, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    assert.ok(
      refreshed.status >= 400 && refreshed.status < 500,
      "A stored service refresh token must be rejected after permission revocation, without a server failure.",
    );
    await authorize(issuer, false);
    mark(
      "Live permission revocation blocked both the stored refresh token and a new SSO authorization.",
    );
    proof = {
      passed: true,
      clientId,
      permission,
      ruleId,
      origin,
      algorithm: "RS256",
      checks: [
        "permission-ui-create",
        "legacy-exact-origin-rule-api-create",
        "denied-before-grant",
        "role-ui-grant",
        "real-sso-pkce",
        "jwks-signature-issuer-audience-subject",
        "atomic-token-scope-only",
        "role-ui-revoke",
        "refresh-rejected",
        "new-sso-denied",
        "owned-rule-api-cleanup",
      ],
    };
  } catch (error) {
    await admin
      .screenshot({
        path: artifacts + "/failure-access-policy.png",
        fullPage: true,
      })
      .catch(() => {});
    throw new Error(
      `Access-policy browser proof failed while ${phase}: ${error instanceof Error ? error.message : "unknown failure"}`,
    );
  } finally {
    if (ruleSaved) {
      const cancel = admin
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true });
      if (await cancel.isVisible().catch(() => false)) await cancel.click();
      if (granted) await changeReaderPermission(false);
      await removeOwnedRule();
      mark(
        "Only the run-owned access rule was deleted; the additive permission remains declared.",
      );
    }
  }
  await writeFile(
    artifacts + "/access-policy.json",
    JSON.stringify(proof, null, 2) + "\n",
  );
}
