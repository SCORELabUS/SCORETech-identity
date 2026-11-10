import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function verifyCatalogueDeletion({ admin, run, artifacts, mark }) {
  async function api(path, body) {
    return admin.evaluate(
      async ({ path, body }) => {
        const c = window.__SCORE_CONFIG__;
        const user = JSON.parse(
          sessionStorage.getItem(`score.user.user:${c.issuer}:${c.clientId}`),
        );
        const response = await fetch(c.adminApiUrl + path, {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: "Bearer " + user.access_token,
            "Content-Type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, data: await response.json() };
      },
      { path, body },
    );
  }
  const current = await api("/catalogue");
  const role = "e2e-deletion-" + run;
  const permission = "e2e-deletion:access-" + run;
  const revisionBody = (catalogue) => ({
    baseSha: current.data.baseSha,
    catalogue,
    reason:
      "Verify disposable catalogue deletion in the local browser laboratory.",
    environments: ["local"],
    sourceEnvironment: "local",
  });
  const listed = await api("/applications");
  const dependency = listed.data.applications.find((app) =>
    app.name.includes(String(run)),
  );
  assert.ok(
    dependency,
    "The run must own a disabled application dependency fixture.",
  );
  const required = dependency.requiredPermissions[0];
  const blockedAttempt = await api(
    "/catalogue/revisions",
    revisionBody({
      ...current.data.catalogue,
      permissions: current.data.catalogue.permissions.filter(
        (item) => item.name !== required,
      ),
      roles: current.data.catalogue.roles.map((item) => ({
        ...item,
        permissions: item.permissions.filter((name) => name !== required),
      })),
    }),
  );
  assert.equal(
    blockedAttempt.status,
    409,
    "A disabled managed application still protects its required permission.",
  );
  assert.equal((await api("/catalogue")).data.baseSha, current.data.baseSha);
  const protectedAttempt = await api(
    "/catalogue/revisions",
    revisionBody({
      ...current.data.catalogue,
      roles: current.data.catalogue.roles.filter(
        (item) => item.name !== "administrador",
      ),
    }),
  );
  assert.equal(protectedAttempt.status, 422);
  const created = await api(
    "/catalogue/revisions",
    revisionBody({
      ...current.data.catalogue,
      permissions: [
        ...current.data.catalogue.permissions,
        { name: permission, description: "Disposable deletion permission" },
      ],
      roles: [
        ...current.data.catalogue.roles,
        {
          name: role,
          description: "Disposable deletion role",
          permissions: [permission],
        },
      ],
    }),
  );
  assert.equal(created.status, 201);
  await expect
    .poll(
      async () => {
        const { data } = await api("/catalogue/environments");
        return data.environments.find((item) => item.environment === "local")
          ?.observedRevision;
      },
      { timeout: 65000 },
    )
    .toBe(created.data.revision.revisions.local);

  await admin.getByRole("button", { name: "Permissions", exact: true }).click();
  await admin
    .getByLabel("Search permissions", { exact: true })
    .fill(permission);
  await admin
    .getByRole("button", {
      name: "Delete permission " + permission,
      exact: true,
    })
    .click();
  let dialog = admin.getByRole("dialog", {
    name: "Delete permission",
    exact: true,
  });
  await dialog
    .getByLabel("Reason for this change", { exact: true })
    .fill("Verify referenced permissions cannot be removed.");
  await expect(
    dialog.getByText(/Remove these references before deleting/),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Delete permission", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await admin.getByRole("button", { name: "Roles", exact: true }).click();
  const table = admin.getByRole("table", {
    name: "Role catalogue",
    exact: true,
  });
  await expect(
    table.getByRole("button", {
      name: "Delete role administrador",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    table.getByRole("button", { name: "Delete role member", exact: true }),
  ).toBeDisabled();
  await admin
    .getByRole("textbox", { name: "Search roles", exact: true })
    .fill(role);
  const removeRole = table.getByRole("button", {
    name: "Delete role " + role,
    exact: true,
  });
  await removeRole.click();
  dialog = admin.getByRole("dialog", { name: "Delete role", exact: true });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(removeRole).toBeVisible();
  await removeRole.click();
  await dialog
    .getByLabel("Reason for this change", { exact: true })
    .fill("Delete only the disposable browser laboratory role.");
  await admin.screenshot({ path: artifacts + "/role-delete-confirmation.png" });
  await dialog
    .getByRole("button", { name: "Delete role", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden", timeout: 65000 });
  await expect(removeRole).toHaveCount(0);
  assert.ok(
    !(await api("/catalogue")).data.catalogue.roles.some(
      (item) => item.name === role,
    ),
  );

  await admin.getByRole("button", { name: "Permissions", exact: true }).click();
  await admin
    .getByLabel("Search permissions", { exact: true })
    .fill(permission);
  const removePermission = admin.getByRole("button", {
    name: "Delete permission " + permission,
    exact: true,
  });
  await removePermission.click();
  dialog = admin.getByRole("dialog", {
    name: "Delete permission",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(removePermission).toBeVisible();
  await removePermission.click();
  await dialog
    .getByLabel("Reason for this change", { exact: true })
    .fill("Delete only the disposable browser laboratory permission.");
  await admin.screenshot({
    path: artifacts + "/permission-delete-confirmation.png",
  });
  await dialog
    .getByRole("button", { name: "Delete permission", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden", timeout: 65000 });
  await expect(removePermission).toHaveCount(0);
  const final = (await api("/catalogue")).data.catalogue;
  assert.ok(!final.permissions.some((item) => item.name === permission));
  assert.ok(
    !final.roles
      .find((item) => item.name === "administrador")
      .permissions.includes(permission),
  );
  mark(
    "Role and permission deletion confirmations, cancellation, dependency protection and protected Admin passed.",
  );
}
