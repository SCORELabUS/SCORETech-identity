import assert from "node:assert/strict";
import { expect } from "@playwright/test";

// Uses the run-owned CAS user and fixture configured by external-sso.mjs.
export async function verifyConnectedIdentities({
  page,
  browser,
  email,
  user,
  api,
  root,
}) {
  const used = new Set();
  async function reauthenticate() {
    await page.locator("#email").fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.locator("#code").waitFor();
    for (let attempt = 0; attempt < 160; attempt++) {
      const data = await fetch("http://localhost:18025/api/v1/messages").then(
        (r) => r.json(),
      );
      const mail = data.messages?.find(
        (m) => !used.has(m.ID) && m.To.some((to) => to.Address === email),
      );
      if (mail) {
        const detail = await fetch(
          "http://localhost:18025/api/v1/message/" + mail.ID,
        ).then((r) => r.json());
        const code = (detail.Text || "").match(/\b[0-9]{6}\b/);
        if (code) {
          used.add(mail.ID);
          await page.locator("#code").fill(code[0]);
          return;
        }
      }
      if (attempt > 4 && attempt % 8 === 0) {
        const resend = page.getByRole("button", {
          name: "Resend code",
          exact: true,
        });
        if ((await resend.isVisible()) && (await resend.isEnabled()))
          await resend.click();
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw Error("No fresh fixture sign-in code");
  }
  try {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.getByRole("button", { name: "Security", exact: true }).click();
    await page
      .getByRole("button", { name: "Manage connected identities", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Connected identities", exact: true }),
    ).toBeVisible();
    const disconnect = page.getByRole("button", {
      name: "Disconnect Universidad de Sevilla",
      exact: true,
    });
    await expect(disconnect).toBeDisabled();
    await expect(
      page.getByText(
        "Verify your email address or connect another sign-in provider before disconnecting this identity.",
      ),
    ).toBeVisible();
    await page.screenshot({
      timeout: 5000,
      animations: "disabled",
      path: root + "test-results/external-sso/connected-identities.png",
    });
    await page
      .getByRole("button", { name: "Preferences", exact: true })
      .click();
    await page.getByRole("radio", { name: "Dark mode", exact: true }).check();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByRole("button", { name: "Security", exact: true }).click();
    await page
      .getByRole("button", { name: "Manage connected identities", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      timeout: 5000,
      animations: "disabled",
      path:
        root + "test-results/external-sso/connected-identities-mobile-dark.png",
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page
      .getByRole("button", { name: "Preferences", exact: true })
      .click();
    await page.getByRole("radio", { name: "Light mode", exact: true }).check();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.getByRole("button", { name: "Security", exact: true }).click();
    await page
      .getByRole("button", { name: "Manage connected identities", exact: true })
      .click();
    // A run-owned verified mailbox provides the independent fallback for disconnect testing.
    api(
      `await call('/users/${user.id}','PUT',{emailVerified:true});console.log('null');`,
    );
    await page.reload();
    await expect(disconnect).toBeEnabled();
    await disconnect.click();
    await reauthenticate();
    await expect(
      page.getByRole("heading", {
        name: "Disconnect Universidad de Sevilla",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    const connect = page.getByRole("button", {
      name: "Connect Universidad de Sevilla",
      exact: true,
    });
    await expect(connect).toBeEnabled({ timeout: 30000 });
    assert.equal(new URL(page.url()).hash, "#security/identities");
    assert.equal(
      api(
        `console.log(JSON.stringify(await call('/users/${user.id}/federated-identity')));`,
      ).length,
      0,
    );
    await connect.click();
    await reauthenticate();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(disconnect).toBeEnabled({ timeout: 30000 });
    const linked = api(
      `console.log(JSON.stringify(await call('/users/${user.id}/federated-identity')));`,
    );
    assert.equal(linked.length, 1);
    assert.equal(linked[0].identityProvider, "us-sso");
    assert.equal(linked[0].userId, `cas-fixture-${email.match(/\d+/)[0]}`);
    assert.equal(
      api(
        `const u=await call('/users?email='+encodeURIComponent(${JSON.stringify(email)})+'&exact=true');console.log(JSON.stringify(u.map(u=>u.id)));`,
      )[0],
      user.id,
    );
    console.log(
      "Connected identities: last-method protection, confirmed disconnect, native linking and stable account passed.",
    );
  } catch (error) {
    console.error(
      "Connected identities screen:",
      await page.locator("body").innerText(),
    );
    await page.screenshot({
      timeout: 5000,
      animations: "disabled",
      path: root + "test-results/external-sso/connected-identities-failure.png",
    });
    throw error;
  }
}
