import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
const require = createRequire(
  new URL("../../packages/identity-internal/package.json", import.meta.url),
);
const { jwtVerify, createRemoteJWKSet } = require("jose");

export async function verifyApplications({
  admin,
  member,
  origin,
  run,
  artifacts,
  mark,
}) {
  assert.equal(new URL(origin).hostname, "localhost");
  const permission = `e2e-service:admin-${run}`;
  const callback = `${origin}/identity/lab-app/callback-${run}`;
  const owned = [];
  let proof;
  async function api(path = "", method = "GET", body) {
    return admin.evaluate(
      async ({ path, method, body }) => {
        const c = window.__SCORE_CONFIG__;
        const user = JSON.parse(
          sessionStorage.getItem(`score.user.user:${c.issuer}:${c.clientId}`) ||
            "null",
        );
        const response = await fetch(c.adminApiUrl + "/applications" + path, {
          method,
          headers: {
            Authorization: "Bearer " + user.access_token,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, data: await response.json() };
      },
      { path, method, body },
    );
  }
  const initial = await api();
  assert.equal(initial.status, 200);
  const issuer = initial.data.issuer;
  async function authorize(context, clientId, allowed = true) {
    const page = await context.newPage();
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callback,
      response_type: "code",
      scope: "openid profile email",
      state,
      nonce: randomBytes(24).toString("base64url"),
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    try {
      const response = await page.goto(
        issuer + "/protocol/openid-connect/auth?" + query,
        { waitUntil: "domcontentloaded" },
      );
      const returned = new URL(page.url());
      const params =
        returned.origin === origin &&
        returned.pathname === new URL(callback).pathname
          ? returned.searchParams
          : undefined;
      if (params)
        assert.equal(
          params.get("state"),
          state,
          "Application callback state mismatch.",
        );
      if (!allowed) {
        assert.ok(
          !params?.get("code"),
          "An unauthorized member obtained an application code.",
        );
        assert.ok(
          response?.status() === 403 ||
            params?.get("error") === "access_denied",
          "Expected a managed application permission denial.",
        );
        return;
      }
      assert.ok(
        params?.get("code") && !params.get("error"),
        "The registered application did not complete SSO.",
      );
      return { code: params.get("code"), verifier };
    } finally {
      await page.close();
    }
  }
  async function tokens(clientId, parameters, clientSecret) {
    const response = await fetch(issuer + "/protocol/openid-connect/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: clientId,
        ...parameters,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, data: await response.json() };
  }
  async function exchange(application, secret) {
    const authorization = await authorize(
      admin.context(),
      application.clientId,
    );
    const parameters = {
      grant_type: "authorization_code",
      redirect_uri: callback,
      code: authorization.code,
      code_verifier: authorization.verifier,
    };
    if (secret) {
      const missing = await tokens(application.clientId, parameters);
      assert.ok(
        missing.status >= 400 && missing.status < 500,
        "A confidential application accepted a token request without its secret.",
      );
    }
    const response = await tokens(application.clientId, parameters, secret);
    assert.equal(
      response.status,
      200,
      "A registered application could not exchange a real PKCE code.",
    );
    let verified;
    try {
      verified = await jwtVerify(
        response.data.access_token,
        createRemoteJWKSet(new URL(issuer + "/protocol/openid-connect/certs")),
        { issuer, audience: application.clientId, algorithms: ["RS256"] },
      );
    } catch {
      throw new Error(
        "The registered application's signed JWT failed verification.",
      );
    }
    assert.deepEqual(
      verified.payload.realm_access?.roles,
      [permission],
      "Application tokens must contain only the selected service permission.",
    );
    assert.equal(typeof response.data.refresh_token, "string");
    return response.data;
  }
  async function create(kind, suffix = "") {
    const name = `E2E ${kind} application ${run}${suffix}`;
    await admin
      .getByRole("button", { name: "Applications", exact: true })
      .click();
    await admin
      .getByLabel("Search applications", { exact: true })
      .fill(String(run));
    await admin
      .getByRole("button", { name: "Create application", exact: true })
      .click();
    const dialog = admin.getByRole("dialog", {
      name: "Create application",
      exact: true,
    });
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
    await dialog
      .getByRole("combobox", { name: "Application type", exact: true })
      .selectOption(kind);
    await dialog
      .getByRole("textbox", { name: "Application origin", exact: true })
      .fill(origin);
    await dialog
      .getByRole("textbox", { name: "Redirect URLs", exact: true })
      .fill(callback);
    if (kind === "public")
      await dialog
        .getByLabel("Post-logout URLs", { exact: true })
        .fill(origin + "/identity/account/");
    await dialog
      .getByLabel("Filter application permissions", { exact: true })
      .fill(permission);
    await dialog.getByLabel(permission, { exact: false }).check();
    const pending = admin.waitForResponse(
      (r) =>
        r.url().endsWith("/applications") && r.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Create application", exact: true })
      .click();
    const response = await pending;
    assert.equal(
      response.status(),
      201,
      "Application registration was rejected.",
    );
    const result = await response.json();
    assert.equal(result.application.name, name);
    assert.deepEqual(
      result.application.postLogoutRedirectUris,
      kind === "public" ? [origin + "/identity/account/"] : [],
    );
    assert.match(result.application.clientId, /^score-app-[a-f0-9-]{36}$/);
    owned.push({ clientId: result.application.clientId, name });
    await dialog.waitFor({ state: "hidden" });
    if (kind === "confidential") {
      assert.ok(
        typeof result.clientSecret === "string" &&
          result.clientSecret.length >= 32,
        "The backend application secret is missing.",
      );
      await admin
        .getByRole("dialog", { name: "Save your client secret", exact: true })
        .waitFor();
      await admin
        .getByRole("button", { name: "I have saved the secret", exact: true })
        .click();
    } else
      assert.equal(
        typeof result.clientSecret,
        "undefined",
        "A browser application must not receive a secret.",
      );
    await admin
      .getByRole("button", { name: "Edit application " + name, exact: true })
      .waitFor();
    return result;
  }
  try {
    // The shared Dialog must distinguish its backdrop from content and drag releases.
    await admin
      .getByRole("button", { name: "Permissions", exact: true })
      .click();
    await admin
      .getByLabel("Search permissions", { exact: true })
      .fill(permission);
    await admin
      .getByRole("table", { name: "Permission catalogue", exact: true })
      .getByRole("button", {
        name: "View permission " + permission,
        exact: true,
      })
      .click();
    const permissionDialog = admin.getByRole("dialog", {
      name: "Permission details",
      exact: true,
    });
    const permissionBounds = await permissionDialog.boundingBox();
    await admin.mouse.click(permissionBounds.x + 8, permissionBounds.y + 8);
    assert.ok(
      await permissionDialog.isVisible(),
      "Clicking dialog padding must keep it open.",
    );
    await admin.mouse.move(
      permissionBounds.x + permissionBounds.width / 2,
      permissionBounds.y + 45,
    );
    await admin.mouse.down();
    await admin.mouse.move(permissionBounds.x - 12, permissionBounds.y + 45);
    await admin.mouse.up();
    assert.ok(
      await permissionDialog.isVisible(),
      "Dragging from inside to outside must not dismiss a dialog.",
    );
    await admin.mouse.click(
      permissionBounds.x - 12,
      permissionBounds.y + permissionBounds.height / 2,
    );
    await permissionDialog.waitFor({ state: "hidden" });
    const browserApp = await create("public");
    await authorize(member.context(), browserApp.application.clientId, false);
    const browserTokens = await exchange(browserApp.application);
    mark(
      "Admin-created public application enforced its permission and completed real OIDC/PKCE without a secret.",
    );
    const backend = await create("confidential");
    const backendTokens = await exchange(
      backend.application,
      backend.clientSecret,
    );
    await admin
      .getByRole("button", {
        name: "Open setup for " + backend.application.name,
        exact: true,
      })
      .click();
    const credentials = admin.getByRole("dialog", {
      name: "Application setup details",
      exact: true,
    });
    assert.ok(
      (await credentials
        .getByLabel("Client secret", { exact: true })
        .inputValue()) === "",
      "A current secret must be hidden until explicitly requested.",
    );
    await credentials
      .getByRole("button", { name: "Show secret", exact: true })
      .click();
    await credentials
      .getByRole("button", { name: "Copy client secret", exact: true })
      .waitFor();
    assert.ok(
      (await credentials
        .getByLabel("Client secret", { exact: true })
        .inputValue()) === backend.clientSecret,
      "Showing a secret must return its existing value without rotating it.",
    );
    await credentials
      .getByRole("button", { name: "Hide secret", exact: true })
      .click();
    assert.ok(
      (await credentials
        .getByLabel("Client secret", { exact: true })
        .inputValue()) === "",
      "The secret must be hidden.",
    );
    await credentials
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await admin
      .getByRole("button", {
        name: "Open setup for " + backend.application.name,
        exact: true,
      })
      .click();
    const reopened = admin.getByRole("dialog", {
      name: "Application setup details",
      exact: true,
    });
    assert.ok(
      (await reopened
        .getByLabel("Client secret", { exact: true })
        .inputValue()) === "",
      "Reopening connection settings must clear the revealed secret.",
    );
    await reopened
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    mark(
      "Explicit secret reveal returned the current value, remained copyable and cleared on hide/close.",
    );
    const list = await api();
    assert.equal(list.status, 200);
    assert.ok(
      !JSON.stringify(list.data).includes(backend.clientSecret),
      "The application list disclosed a client secret.",
    );
    await admin
      .getByRole("button", {
        name: "Open setup for " + backend.application.name,
        exact: true,
      })
      .click();
    await admin
      .getByRole("dialog", { name: "Application setup details", exact: true })
      .getByRole("button", { name: "Rotate secret", exact: true })
      .click();
    const rotate = admin.getByRole("dialog", {
      name: "Rotate client secret",
      exact: true,
    });
    const pending = admin.waitForResponse(
      (r) =>
        r.url().endsWith("/" + backend.application.clientId + "/secret") &&
        r.request().method() === "POST",
    );
    await rotate
      .getByRole("button", { name: "Rotate secret", exact: true })
      .click();
    const rotatedResponse = await pending;
    assert.equal(rotatedResponse.status(), 200);
    const rotated = await rotatedResponse.json();
    assert.ok(
      typeof rotated.clientSecret === "string" &&
        rotated.clientSecret !== backend.clientSecret,
      "Secret rotation must replace the credential.",
    );
    await admin
      .getByRole("button", { name: "I have saved the secret", exact: true })
      .click();
    const old = await tokens(
      backend.application.clientId,
      {
        grant_type: "refresh_token",
        refresh_token: backendTokens.refresh_token,
      },
      backend.clientSecret,
    );
    assert.ok(
      old.status >= 400 && old.status < 500,
      "The old application secret remained valid after rotation.",
    );
    const fresh = await tokens(
      backend.application.clientId,
      {
        grant_type: "refresh_token",
        refresh_token: backendTokens.refresh_token,
      },
      rotated.clientSecret,
    );
    assert.equal(
      fresh.status,
      200,
      "The rotated application secret could not authenticate.",
    );
    mark(
      "Admin-created backend application required its secret, and rotation invalidated the old secret.",
    );
    await admin
      .getByRole("button", {
        name: "Open setup for " + browserApp.application.name,
        exact: true,
      })
      .click();
    await admin
      .getByRole("dialog")
      .getByLabel("Client ID", { exact: true })
      .waitFor();
    await admin
      .getByRole("dialog")
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await admin
      .getByRole("button", {
        name: "Edit application " + browserApp.application.name,
        exact: true,
      })
      .click();
    const edit = admin.getByRole("dialog", {
      name: "Edit application",
      exact: true,
    });
    await edit.getByLabel("Application enabled", { exact: false }).uncheck();
    const updated = admin.waitForResponse(
      (r) =>
        r.url().endsWith("/applications/" + browserApp.application.clientId) &&
        r.request().method() === "PUT",
    );
    await edit
      .getByRole("button", { name: "Save application", exact: true })
      .click();
    assert.equal((await updated).status(), 200);
    await edit.waitFor({ state: "hidden" });
    const denied = await tokens(browserApp.application.clientId, {
      grant_type: "refresh_token",
      refresh_token: browserTokens.refresh_token,
    });
    assert.ok(
      denied.status >= 400 && denied.status < 500,
      "A disabled application could still refresh tokens.",
    );
    await admin.evaluate(() => window.scrollTo(0, 0));
    const disposable = await create("public", " deletion fixture");
    const disposableTokens = await exchange(disposable.application);
    let deleteRequests = 0;
    const countDelete = (request) => {
      if (
        request.method() === "DELETE" &&
        request
          .url()
          .endsWith("/applications/" + disposable.application.clientId)
      )
        deleteRequests++;
    };
    admin.on("request", countDelete);
    try {
      const openDelete = () =>
        admin
          .getByRole("button", {
            name: "Delete application " + disposable.application.name,
            exact: true,
          })
          .click();
      await openDelete();
      let confirmation = admin.getByRole("dialog", {
        name: "Delete application",
        exact: true,
      });
      await confirmation
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await confirmation.waitFor({ state: "hidden" });
      assert.equal(
        deleteRequests,
        0,
        "Cancel must not send a deletion request.",
      );
      await openDelete();
      confirmation = admin.getByRole("dialog", {
        name: "Delete application",
        exact: true,
      });
      const bounds = await confirmation.boundingBox();
      await admin.mouse.click(bounds.x - 12, bounds.y + bounds.height / 2);
      await confirmation.waitFor({ state: "hidden" });
      assert.equal(
        deleteRequests,
        0,
        "Dismissing confirmation must not delete an application.",
      );
      await openDelete();
      confirmation = admin.getByRole("dialog", {
        name: "Delete application",
        exact: true,
      });
      await admin.screenshot({
        path: artifacts + "/application-delete-confirmation.png",
        fullPage: true,
      });
      const pending = admin.waitForResponse(
        (response) =>
          response.request().method() === "DELETE" &&
          response
            .url()
            .endsWith("/applications/" + disposable.application.clientId),
      );
      await confirmation
        .getByRole("button", { name: "Delete application", exact: true })
        .click();
      assert.equal((await pending).status(), 200);
      await confirmation.waitFor({ state: "hidden" });
      await admin
        .getByRole("button", {
          name: "Delete application " + disposable.application.name,
          exact: true,
        })
        .waitFor({ state: "hidden" });
      assert.ok(
        !(await api()).data.applications.some(
          (item) => item.clientId === disposable.application.clientId,
        ),
        "Deleted applications must leave the directory.",
      );
      const rejected = await tokens(disposable.application.clientId, {
        grant_type: "refresh_token",
        refresh_token: disposableTokens.refresh_token,
      });
      assert.ok(
        rejected.status >= 400 && rejected.status < 500,
        "Deleted clients must reject their prior refresh token.",
      );
      assert.equal(deleteRequests, 1);
    } finally {
      admin.off("request", countDelete);
    }
    mark(
      "Backdrop dismissal, drag protection, deletion confirmation/cancel, client removal and refresh rejection passed.",
    );
    await admin.screenshot({
      path: artifacts + "/applications.png",
      fullPage: true,
    });
    const viewport = admin.viewportSize();
    await admin.setViewportSize({ width: 390, height: 844 });
    await admin.reload();
    await admin
      .getByLabel("Search applications", { exact: true })
      .fill(String(run));
    await admin
      .getByRole("button", {
        name: "Edit application " + browserApp.application.name,
        exact: true,
      })
      .waitFor();
    await admin.evaluate(() => document.fonts.ready);
    assert.ok(
      await admin.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Managed applications must fit a mobile viewport.",
    );
    await admin.screenshot({
      path: artifacts + "/applications-mobile.png",
      fullPage: true,
      animations: "disabled",
    });
    await admin.setViewportSize(viewport);
    await admin.reload();
    await admin
      .getByLabel("Search applications", { exact: true })
      .fill(String(run));
    await admin
      .getByRole("button", {
        name: "Edit application " + browserApp.application.name,
        exact: true,
      })
      .waitFor();
    mark(
      "Application setup details, edit/disable and refresh-token blocking passed.",
    );
    proof = {
      passed: true,
      checks: [
        "public-ui-registration",
        "generated-client-id",
        "public-no-secret",
        "permission-admission",
        "real-pkce-jwt-scope",
        "confidential-ui-registration",
        "secret-required",
        "secret-not-listed",
        "explicit-current-secret-reveal-copy-hide",
        "rotation-old-secret-rejected",
        "rotated-secret-accepted",
        "setup-details",
        "ui-disable-refresh-rejected",
        "owned-applications-disabled",
        "backdrop-and-drag-dismissal",
        "delete-cancel-confirm-and-client-revocation",
      ],
    };
  } finally {
    const hide = admin.getByRole("button", {
      name: "Hide secret",
      exact: true,
    });
    if (await hide.isVisible().catch(() => false)) await hide.click();
    // Hide any credential before the parent harness captures an error screenshot.
    const saved = admin.getByRole("button", {
      name: "I have saved the secret",
      exact: true,
    });
    if (await saved.isVisible().catch(() => false)) await saved.click();
    const current = await api();
    if (current.status === 200)
      for (const ownedApp of owned) {
        const application = current.data.applications.find(
          (a) => a.clientId === ownedApp.clientId && a.name === ownedApp.name,
        );
        if (application?.enabled) {
          const { clientId, version, ...settings } = application;
          const result = await api("/" + clientId, "PUT", {
            ...settings,
            version,
            enabled: false,
          });
          assert.equal(
            result.status,
            200,
            "Could not disable the run-owned application fixture.",
          );
        }
      }
  }
  await writeFile(
    artifacts + "/applications.json",
    JSON.stringify(proof, null, 2) + "\n",
  );
  return {
    verifyTypeChanges: async (reauthenticate) => {
      await admin.setViewportSize({ width: 1280, height: 720 });
      await admin.goto(origin + "/identity/admin/#applications");
      await admin
        .getByLabel("Search applications", { exact: true })
        .fill(String(run));
      const own = owned.find(
        (item) => item.name === `E2E public application ${run}`,
      );
      assert.ok(own, "The run-owned public application is missing.");
      await admin
        .getByRole("button", {
          name: "Edit application " + own.name,
          exact: true,
        })
        .waitFor();
      const current = (await api()).data.applications.find(
        (item) => item.clientId === own.clientId && item.name === own.name,
      );
      assert.ok(current && !current.enabled && current.kind === "public");
      const { clientId, version, ...settings } = current;
      assert.equal(
        (
          await api("/" + clientId, "PUT", {
            ...settings,
            version,
            enabled: true,
          })
        ).status,
        200,
      );
      await admin.reload();
      const oldPublic = await exchange({ ...current, enabled: true });
      async function change(kind) {
        await admin
          .getByLabel("Search applications", { exact: true })
          .fill(String(run));
        await admin
          .getByRole("button", {
            name: "Edit application " + own.name,
            exact: true,
          })
          .click();
        const dialog = admin.getByRole("dialog", {
          name: "Edit application",
          exact: true,
        });
        await dialog
          .getByRole("combobox", { name: "Application type", exact: true })
          .selectOption(kind);
        await dialog.getByRole("note").waitFor();
        const cancel = dialog.getByRole("button", {
          name: "Cancel",
          exact: true,
        });
        const save = dialog.getByRole("button", {
          name: "Save application",
          exact: true,
        });
        const positions = await dialog.evaluate((element) => {
          const buttons = [...element.querySelectorAll(".form-actions button")];
          return buttons.map((button) => ({
            text: button.textContent.trim(),
            x: button.getBoundingClientRect().x,
          }));
        });
        assert.equal(positions[0].text, "Cancel");
        assert.ok(
          positions[0].x < positions[1].x,
          "Cancel must be left of the primary confirmation.",
        );
        await admin.screenshot({
          path: artifacts + "/application-type-edit.png",
          fullPage: true,
        });
        const pending = admin.waitForResponse(
          (r) =>
            r.url().endsWith("/applications/" + clientId) &&
            r.request().method() === "PUT",
        );
        await save.click();
        const response = await pending;
        assert.equal(
          response.status(),
          200,
          "The application type change was rejected.",
        );
        return await response.json();
      }
      const upgraded = await change("confidential");
      assert.equal(upgraded.application.clientId, clientId);
      assert.equal(upgraded.application.kind, "confidential");
      assert.ok(
        typeof upgraded.clientSecret === "string" &&
          upgraded.clientSecret.length >= 32,
        "A backend transition must return its new secret once.",
      );
      const rejectedPublic = await tokens(
        clientId,
        { grant_type: "refresh_token", refresh_token: oldPublic.refresh_token },
        upgraded.clientSecret,
      );
      assert.ok(
        rejectedPublic.status >= 400 && rejectedPublic.status < 500,
        "The old public session survived a client-type transition.",
      );
      const secretDialog = admin.getByRole("dialog", {
        name: "Save your client secret",
        exact: true,
      });
      await secretDialog
        .getByRole("button", { name: "Copy client secret", exact: true })
        .waitFor();
      assert.ok(
        await secretDialog.isVisible(),
        "The new secret must remain available even if the administrator SSO session has ended.",
      );
      await secretDialog
        .getByRole("button", { name: "I have saved the secret", exact: true })
        .click();
      await reauthenticate();
      const backendTokens = await exchange(
        upgraded.application,
        upgraded.clientSecret,
      );
      const downgraded = await change("public");
      assert.equal(downgraded.application.clientId, clientId);
      assert.equal(downgraded.application.kind, "public");
      assert.equal(typeof downgraded.clientSecret, "undefined");
      const rejectedBackend = await tokens(clientId, {
        grant_type: "refresh_token",
        refresh_token: backendTokens.refresh_token,
      });
      assert.ok(
        rejectedBackend.status >= 400 && rejectedBackend.status < 500,
        "The old confidential session survived a client-type transition.",
      );
      await reauthenticate();
      const versioned = (await api()).data.applications.find(
        (item) => item.clientId === clientId,
      );
      const {
        clientId: stableId,
        version: latest,
        ...finalSettings
      } = versioned;
      assert.equal(
        (
          await api("/" + stableId, "PUT", {
            ...finalSettings,
            version: latest,
            enabled: false,
          })
        ).status,
        200,
      );
      mark(
        "Editable application type, stable client ID, one-time transition secret, revoked old sessions and right-aligned modal actions passed.",
      );
      await writeFile(
        artifacts + "/application-types.json",
        JSON.stringify(
          {
            passed: true,
            checks: [
              "public-to-confidential",
              "confidential-to-public",
              "stable-client-id",
              "transition-secret-copy-control",
              "old-refresh-tokens-rejected",
              "cancel-left-primary-right",
              "admin-reauthentication",
              "fixture-disabled",
            ],
          },
          null,
          2,
        ) + "\n",
      );
    },
  };
}
