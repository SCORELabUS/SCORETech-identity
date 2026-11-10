import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function verifyPaginationSession({
  admin,
  origin,
  run,
  artifacts,
  mark,
}) {
  const prefix = `e2e-page-${run}`;
  const invitationIds = [];
  async function api(path, method = "GET", body) {
    return admin.evaluate(
      async ({ path, method, body }) => {
        const c = window.__SCORE_CONFIG__;
        const user = JSON.parse(
          sessionStorage.getItem(`score.user.user:${c.issuer}:${c.clientId}`),
        );
        const response = await fetch(c.adminApiUrl + path, {
          method,
          headers: {
            Authorization: "Bearer " + user.access_token,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return {
          status: response.status,
          data: response.status === 204 ? null : await response.json(),
        };
      },
      { path, method, body },
    );
  }
  async function publish(roles) {
    const { data } = await api("/catalogue");
    const result = await api("/catalogue/revisions", "POST", {
      baseSha: data.baseSha,
      catalogue: { ...data.catalogue, roles: roles(data.catalogue.roles) },
      environments: ["local"],
      sourceEnvironment: "local",
      reason:
        "Verify disposable pagination roles in the local browser laboratory.",
    });
    assert.equal(result.status, 201);
    await expect
      .poll(
        async () =>
          (await api("/catalogue/environments")).data.environments[0]
            .observedRevision,
        { timeout: 65000 },
      )
      .toBe(result.data.revision.revisions.local);
  }
  const roleName = (index) => `${prefix}-${String(index).padStart(2, "0")}`;
  try {
    await publish((roles) => [
      ...roles,
      ...Array.from({ length: 26 }, (_, index) => ({
        name: roleName(index),
        description: "Pagination role " + index,
        permissions: [],
      })),
    ]);
    await admin.getByRole("button", { name: "Roles", exact: true }).click();
    await admin.getByLabel("Search roles", { exact: true }).fill(prefix);
    const roles = admin.getByRole("table", {
      name: "Role catalogue",
      exact: true,
    });
    await expect(roles.locator("tbody tr")).toHaveCount(25);
    await admin.getByRole("button", { name: "Next", exact: true }).click();
    await expect(roles.locator("tbody tr")).toHaveCount(1);
    await admin.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(roles.locator("tbody tr")).toHaveCount(25);
    await admin.getByLabel("Search roles", { exact: true }).fill(roleName(25));
    await expect(roles.locator("tbody tr")).toHaveCount(1);

    // Exercise the real refresh-token endpoint, including a transient network
    // failure. Only local expiry metadata is accelerated; tokens are not forged.
    const issuer = await admin.evaluate(() => window.__SCORE_CONFIG__.issuer);
    const tokenUrl = issuer + "/protocol/openid-connect/token";
    let attempts = 0;
    await admin.route(tokenUrl, async (route) => {
      if (
        new URLSearchParams(route.request().postData()).get("grant_type") ===
          "refresh_token" &&
        ++attempts === 1
      )
        await route.abort("failed");
      else await route.continue();
    });
    const renewed = admin.waitForResponse(
      (response) =>
        response.url() === tokenUrl &&
        response.status() === 200 &&
        response.request().postData()?.includes("grant_type=refresh_token"),
      { timeout: 20000 },
    );
    await admin.evaluate(() => {
      const c = window.__SCORE_CONFIG__,
        key = `score.user.user:${c.issuer}:${c.clientId}`;
      const value = JSON.parse(sessionStorage.getItem(key));
      value.expires_at = Math.floor(Date.now() / 1000) + 4;
      sessionStorage.setItem(key, JSON.stringify(value));
    });
    await admin.reload();
    await admin.getByLabel("Search roles", { exact: true }).fill(roleName(25));
    await renewed;
    await admin.unroute(tokenUrl);
    assert.ok(attempts >= 2);
    await expect(
      admin.getByRole("heading", {
        name: "The right access, by design.",
        exact: true,
      }),
    ).toBeVisible();
    await expect(admin.getByLabel("Search roles", { exact: true })).toHaveValue(
      roleName(25),
    );
    assert.equal(admin.url(), origin + "/identity/admin/#roles");
    await expect(
      admin.getByRole("button", {
        name: "Sign in to SCORETech Identity",
        exact: true,
      }),
    ).toHaveCount(0);
    await admin.screenshot({ path: artifacts + "/roles-renewed-session.png" });
    mark(
      "Real silent token renewal recovered from a network failure without losing the page or search.",
    );

    for (let index = 0; index < 26; index++) {
      const result = await api("/invitations", "POST", {
        name: roleName(index),
        roles: ["member"],
        limit: 1,
        expiresAt: Date.now() + 3000,
      });
      assert.equal(result.status, 201);
      invitationIds.push(result.data.invitation.id);
    }
    await admin
      .getByRole("button", { name: "Invitations", exact: true })
      .click();
    const searched = admin.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith("/invitations") &&
        url.searchParams.get("search") === prefix &&
        url.searchParams.get("first") === "0"
      );
    });
    await admin.getByLabel("Search invitations", { exact: true }).fill(prefix);
    await searched;
    const invitations = admin.getByRole("table", {
      name: "Invitations",
      exact: true,
    });
    await expect(invitations.locator("tbody tr")).toHaveCount(25);
    await expect(invitations.locator("tbody tr").first()).toContainText(prefix);
    await admin.getByRole("button", { name: "Next", exact: true }).click();
    await expect(invitations.locator("tbody tr")).toHaveCount(1);
    await admin.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(invitations.locator("tbody tr")).toHaveCount(25);
    await admin
      .getByLabel("Search invitations", { exact: true })
      .fill(roleName(0));
    await expect(invitations.locator("tbody tr")).toHaveCount(1);
    await admin
      .getByRole("button", { name: "Refresh invitations", exact: true })
      .click();
    await expect(invitations.locator("tbody tr")).toHaveCount(1);
    await admin
      .getByLabel("Search invitations", { exact: true })
      .fill(prefix + "-absent");
    await expect(
      admin.getByRole("heading", { name: "No invitations found", exact: true }),
    ).toBeVisible();
    await expect(admin.getByText("Showing 0–0", { exact: true })).toBeVisible();
    mark(
      "Role/invitation search and pagination passed across two pages, including a global invitation match and empty results.",
    );
  } finally {
    await admin.unroute(/\/protocol\/openid-connect\/token$/);
    await expect
      .poll(
        async () => {
          if (!invitationIds.length) return true;
          return (
            (await api("/invitations/" + invitationIds.at(-1))).data.state ===
            "expired"
          );
        },
        { timeout: 10000 },
      )
      .toBe(true);
    for (const id of invitationIds)
      assert.equal((await api("/invitations/" + id, "DELETE")).status, 204);
    await publish((roles) =>
      roles.filter((role) => !role.name.startsWith(prefix + "-")),
    );
  }
}
