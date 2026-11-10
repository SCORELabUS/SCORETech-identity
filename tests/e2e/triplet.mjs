import { verifyPaginationSession } from "./pagination-session.mjs";
// Disposable, loopback-only browser verification. Never accepts a deployed origin.
import { chromium, expect } from "@playwright/test";
import { verifyCatalogueDeletion } from "./catalogue-deletion.mjs";
import { verifyApplications } from "./applications.mjs";
import { verifyAccessPolicy } from "./access-policy.mjs";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
const root = new URL("../../", import.meta.url).pathname;
const origin = process.env.IDENTITY_E2E_ORIGIN || "http://localhost:18000";
if (
  new URL(origin).hostname !== "localhost" ||
  new URL(origin).protocol !== "http:"
)
  throw new Error("E2E only uses the isolated localhost laboratory.");
const run = Date.now();
const adminEmail = `e2e-admin-${run}@example.invalid`,
  memberEmail = `e2e-member-${run}@example.invalid`;
const artifacts = root + "test-results/triplet";
await mkdir(artifacts, { recursive: true });
// Never leave a previous run's success record beside a failed fresh run.
for (const file of [
  "result.json",
  "access-policy.json",
  "applications.json",
  "application-types.json",
])
  await rm(artifacts + "/" + file, { force: true });
const compose = [
  "compose",
  "--project-directory",
  root,
  "-f",
  root + "deploy/local/compose.yaml",
  "exec",
  "-T",
  "catalogue-fixture",
  "node",
  "--input-type=module",
  "-e",
];
function fixture(action, email) {
  assert.match(email, /^e2e-(admin|member)-\d+@example\.invalid$/);
  const code = `const base='http://keycloak:8080/identity/auth';const login=await fetch(base+'/realms/master/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:'fixture-admin',password:'fixture-local-only'})});if(!login.ok)throw Error('Fixture auth failed');const {access_token}=await login.json();const headers={Authorization:'Bearer '+access_token,'Content-Type':'application/json'};const url=base+'/admin/realms/score';const email=${JSON.stringify(email)};const action=${JSON.stringify(action)};const request=async(path,method='GET',body)=>{const r=await fetch(url+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});if(!r.ok)throw Error('Fixture operation '+r.status);return r.status===204?null:r.json();};if(action==='create'){const r=await fetch(url+'/users',{method:'POST',headers,body:JSON.stringify({username:email,email,firstName:'Test',lastName:'Operator',enabled:true,emailVerified:true})});if(r.status!==201)throw Error('Fixture creation failed');const [user]=await request('/users?email='+encodeURIComponent(email)+'&exact=true');await request('/users/'+user.id+'/role-mappings/realm','POST',[await request('/roles/administrador')]);}else{for(const user of await request('/users?email='+encodeURIComponent(email)+'&exact=true')){if(user.email!==email)throw Error('Unsafe cleanup');await request('/users/'+user.id,'DELETE');}}`;
  execFileSync("docker", [...compose, code], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
const browser = await chromium.launch({
  headless: true,
  ...(process.env.IDENTITY_E2E_CHROMIUM
    ? {}
    : {
        executablePath:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
});
const adminContext = await browser.newContext({
    locale: "es-ES",
    timezoneId: "America/Los_Angeles",
  }),
  memberContext = await browser.newContext({
    locale: "es-ES",
    timezoneId: "America/Los_Angeles",
  });
adminContext.setDefaultTimeout(30000);
memberContext.setDefaultTimeout(30000);
let admin, member;
const errors = [];
const mark = (message) => console.log("E2E:", message);
const consumedMessages = new Set();
async function attach(context) {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => void dialog.accept("SCORE test passkey"));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return page;
}
async function code(email, page) {
  let resent = false;
  for (let attempt = 0; attempt < 400; attempt++) {
    const list = await fetch("http://localhost:18025/api/v1/messages").then(
      (r) => r.json(),
    );
    const message = list.messages?.find(
      (m) =>
        !consumedMessages.has(m.ID) && m.To.some((to) => to.Address === email),
    );
    if (message) {
      const detail = await fetch(
        "http://localhost:18025/api/v1/message/" + message.ID,
      ).then((r) => r.json());
      const match = (detail.Text || "").match(/\b[0-9]{6}\b/);
      if (match) {
        consumedMessages.add(message.ID);
        return match[0];
      }
    }
    // A second login respects the provider's per-address resend cooldown.
    // Never reuse the code consumed by the previous authentication session.
    if (page && attempt > 4 && !resent) {
      const resend = page.getByRole("button", {
        name: "Resend code",
        exact: true,
      });
      if (await resend.isEnabled().catch(() => false)) {
        resent = true;
        await resend.click();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error("No captured sign-in code for fixture.");
}
async function captureAuth(page, name, mobile = false) {
  await page.evaluate(() => document.fonts.ready);
  const remember = page
    .locator(".checkbox")
    .filter({ has: page.locator('input[name="rememberMe"]') });
  if (await remember.count()) {
    const clear = await remember.evaluate((label) => {
      const input = label.querySelector("input").getBoundingClientRect();
      const text = [...label.childNodes].find(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
      );
      const range = document.createRange();
      range.selectNodeContents(text);
      return range.getBoundingClientRect().left >= input.right;
    });
    assert.ok(
      clear,
      "The remember-device checkbox must not overlap its label.",
    );
  }
  await page.screenshot({
    path: artifacts + "/" + name + ".png",
    fullPage: true,
    animations: "disabled",
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: artifacts + "/" + name + "-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  if (mobile) {
    const original = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Authentication controls must not overflow on mobile.",
    );
    await page.screenshot({
      path: artifacts + "/" + name + "-mobile.png",
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize(original);
  }
  await page.emulateMedia({ colorScheme: null });
}
async function signIn(page, kind, email) {
  await page.goto(origin + "/identity/" + kind + "/");
  await page
    .getByRole("button", { name: "Sign in to SCORETech Identity", exact: true })
    .click();
  await page.locator("#email").waitFor();
  await captureAuth(page, "auth-" + kind + "-login", true);
  if (await page.locator("#email").isVisible()) {
    await page.locator("#email").fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }
  await page.locator("#code").waitFor();
  await captureAuth(page, "auth-" + kind + "-code");
  await page.locator("#code").fill(await code(email, page));
}
function authenticatorCode(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = secret
    .replace(/[ =\s]/g, "")
    .toUpperCase()
    .split("")
    .map((character) =>
      alphabet.indexOf(character).toString(2).padStart(5, "0"),
    )
    .join("");
  const key = Buffer.from(
    (bits.match(/.{8}/g) || []).map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hash = createHmac("sha1", key).update(counter).digest();
  const offset = hash[19] & 15;
  return ((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, "0");
}
async function applied(revision) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = JSON.parse(
      await readFile(root + ".lab/catalogue/apply-status.json", "utf8"),
    );
    if (state.state === "applied" && state.observedRevision === revision)
      return;
    if (state.state === "failed")
      throw Error("Provider catalogue verification failed: " + state.detail);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Error("The published revision was not applied.");
}
try {
  fixture("create", adminEmail);
  admin = await attach(adminContext);
  member = await attach(memberContext);
  await signIn(admin, "admin", adminEmail);
  await admin.locator("#registerWebAuthn").waitFor();
  await admin.locator("#registerWebAuthn").click();
  await admin
    .getByRole("heading", { name: "People power the ecosystem." })
    .waitFor({ timeout: 30000 });
  mark("Administrative OTP + passkey onboarding and prefixed callback passed.");
  await expect(
    admin.getByRole("link", { name: "My account", exact: true }),
  ).toHaveCount(0);
  await admin.locator('summary[aria-label="Account menu"]').click();
  await expect(
    admin.getByRole("link", { name: "My profile", exact: true }),
  ).toBeVisible();
  await expect(admin.locator(".topbar")).toHaveCount(0);
  await admin.keyboard.press("Escape");

  await admin.screenshot({
    path: artifacts + "/admin-directory.png",
    fullPage: true,
  });
  await admin.getByRole("button", { name: "Roles", exact: true }).click();
  await admin.getByRole("button", { name: "Create role", exact: true }).click();
  const role = "e2e-reader-" + run;
  await admin.getByLabel("Role identifier", { exact: true }).fill(role);
  await admin
    .getByLabel("Description", { exact: true })
    .fill("E2E directory reader " + run);
  await admin.getByLabel("Access service", { exact: false }).check();
  await admin
    .getByLabel("identity:users:view", { exact: false })
    .first()
    .check();
  await admin
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await admin
    .getByLabel("Reason for this change", { exact: true })
    .fill("Verify role publication from the SCORE browser laboratory.");
  const published = admin.waitForResponse(
    (r) =>
      r.url().endsWith("/catalogue/revisions") &&
      r.request().method() === "POST",
  );
  await admin
    .getByRole("button", { name: "Publish changes", exact: true })
    .click();
  const response = await published;
  assert.equal(response.status(), 201, await response.text());
  const publication = await response.json();
  await applied(publication.revision.revisions.local);
  await expect(
    admin.getByText("The role catalogue is applied and verified.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await admin
    .getByRole("textbox", { name: "Search roles", exact: true })
    .fill(role);
  await admin
    .getByRole("table", { name: "Role catalogue", exact: true })
    .getByText("E2E directory reader " + run, { exact: true })
    .waitFor();
  mark("Role editor, versioned commit and real provider application passed.");
  await admin.screenshot({
    path: artifacts + "/role-catalogue.png",
    fullPage: true,
  });
  await signIn(member, "account", memberEmail);
  await member.locator("#firstName").waitFor();
  await captureAuth(member, "auth-registration", true);
  await member.locator("#firstName").fill("E2E");
  await member.locator("#lastName").fill("Researcher");
  await member.locator("#terms").check();
  await member.locator("#privacy").check();
  await member
    .getByRole("button", { name: "Create account", exact: false })
    .click();
  await member
    .getByRole("heading", { name: "Your profile.", exact: true })
    .waitFor({ timeout: 30000 });
  mark("Public verified-email registration passed, without service grants.");
  await member.getByLabel("First name", { exact: true }).fill("Updated");
  await member
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await member
    .getByText("Your profile has been updated.", { exact: true })
    .waitFor();
  await member.reload();
  await member.getByLabel("First name", { exact: true }).waitFor();
  assert.equal(
    await member.getByLabel("First name", { exact: true }).inputValue(),
    "Updated",
  );
  await member.getByRole("button", { name: "Security", exact: true }).click();
  await member
    .getByRole("heading", { name: "Sign-in methods", exact: true })
    .waitFor();
  await member
    .getByRole("button", { name: "Devices and sessions", exact: true })
    .click();
  await member
    .getByRole("heading", { name: "Active sessions", exact: true })
    .waitFor();
  await expect(
    member.getByRole("link", { name: "Administration", exact: true }),
  ).toHaveCount(0);
  mark("Profile persistence, security and sessions passed.");
  await member.goto(origin + "/identity/admin/");
  // The Account session is recovered automatically by Admin's same-origin SSO
  // probe; authorization must still deny this member without another sign-in.
  await member
    .getByRole("heading", { name: "Access is not available.", exact: true })
    .waitFor({ timeout: 30000 });
  mark("SSO worked and Admin refused an ordinary member.");
  // Use the actual Admin UI to assign the newly created delegated role.
  await admin.getByRole("button", { name: "Users", exact: true }).click();
  await admin
    .getByRole("button", { name: "Refresh directory", exact: true })
    .click();
  await admin
    .getByRole("button", { name: "Open " + memberEmail, exact: true })
    .click();
  await admin.getByRole("tab", { name: "Roles", exact: true }).click();
  await admin.getByLabel(role, { exact: true }).check();
  await admin.getByRole("button", { name: "Save roles", exact: true }).click();
  await admin
    .getByText(
      "Roles updated. New access takes effect when tokens are renewed.",
      { exact: true },
    )
    .waitFor();
  await admin
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  // A prior email session cannot bypass passkey enrollment after promotion.
  await member.locator('summary[aria-label="Account menu"]').click();
  await member.getByRole("button", { name: "Sign out", exact: true }).click();
  await signIn(member, "admin", memberEmail);
  await member.locator("#registerWebAuthn").waitFor();
  await member.locator("#registerWebAuthn").click();
  await member
    .getByRole("heading", { name: "People power the ecosystem.", exact: true })
    .waitFor();
  assert.equal(
    await member.getByRole("button", { name: "Add user", exact: true }).count(),
    0,
  );
  mark(
    "Live role assignment and mandatory passkey for a delegated administrator passed.",
  );
  await verifyAccessPolicy({ admin, member, origin, run, artifacts, mark });
  await expect(
    admin.getByRole("button", { name: "Access rules", exact: true }),
  ).toHaveCount(0);
  await admin.goto(origin + "/identity/admin/#access-rules");
  await expect(
    admin.getByRole("heading", {
      name: "Connected applications.",
      exact: true,
    }),
  ).toBeVisible();
  assert.ok(
    admin.url().endsWith("#applications"),
    "Retired Access rules links must lead to Applications.",
  );
  const delegatedAccount = await member.context().newPage();
  await delegatedAccount.goto(origin + "/identity/account/");
  await delegatedAccount
    .getByRole("heading", { name: "Your profile.", exact: true })
    .waitFor();
  await delegatedAccount.getByLabel("First name", { exact: true }).waitFor();
  await expect(
    delegatedAccount.getByRole("link", { name: "Administration", exact: true }),
  ).toHaveCount(0);
  await delegatedAccount.close();
  const managedApplications = await verifyApplications({
    admin,
    member,
    origin,
    run,
    artifacts,
    mark,
  });
  await admin.getByRole("button", { name: "Invitations", exact: true }).click();
  await admin
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await admin
    .getByLabel("Invitation name", { exact: true })
    .fill("E2E invitation " + run);
  await admin
    .getByLabel("Expires at (optional)", { exact: true })
    .fill(new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 16));
  const createdInvitation = admin.waitForResponse(
    (r) => r.url().endsWith("/invitations") && r.request().method() === "POST",
  );
  await admin
    .getByRole("dialog")
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  const invitationResponse = await createdInvitation;
  assert.equal(invitationResponse.status(), 201);
  const invitationData = await invitationResponse.json();
  await admin
    .getByRole("heading", { name: "Invitation link", exact: true })
    .waitFor();
  const invitation = admin
    .getByRole("table", { name: "Invitations", exact: true })
    .getByRole("row")
    .filter({ hasText: "E2E invitation " + run });
  await invitation
    .getByRole("button", {
      name: "Edit invitation E2E invitation " + run,
      exact: true,
    })
    .click();
  await admin
    .getByLabel("Invitation name", { exact: true })
    .fill("E2E invitation edited " + run);
  const updatedInvitation = admin.waitForResponse(
    (r) =>
      r.url().includes("/invitations/" + invitationData.invitation.id) &&
      r.request().method() === "PATCH",
  );
  await admin
    .getByRole("dialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  const updatedResponse = await updatedInvitation;
  assert.equal(updatedResponse.status(), 200);
  assert.equal(
    updatedResponse.request().postDataJSON().expiresAt,
    invitationData.invitation.expiresAt,
    "Editing an invitation must preserve its expiry across time zones.",
  );
  const editedInvitation = admin
    .getByRole("table", { name: "Invitations", exact: true })
    .getByRole("row")
    .filter({ hasText: "E2E invitation edited " + run });
  await editedInvitation
    .getByRole("button", {
      name: "Revoke invitation E2E invitation edited " + run,
      exact: true,
    })
    .click();
  let invitationDialog = admin.getByRole("dialog", {
    name: "Revoke invitation",
    exact: true,
  });
  await invitationDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(
    editedInvitation.getByText("active", { exact: true }),
  ).toBeVisible();
  await expect(
    editedInvitation.getByRole("button", { name: /^Delete invitation / }),
  ).toHaveCount(0);
  const rejectedActiveDelete = await admin.evaluate(async (id) => {
    const c = window.__SCORE_CONFIG__;
    const user = JSON.parse(
      sessionStorage.getItem(`score.user.user:${c.issuer}:${c.clientId}`),
    );
    return (
      await fetch(c.adminApiUrl + "/invitations/" + id, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + user.access_token },
      })
    ).status;
  }, invitationData.invitation.id);
  assert.equal(rejectedActiveDelete, 409);
  await editedInvitation
    .getByRole("button", { name: /^Revoke invitation / })
    .click();
  await invitationDialog
    .getByRole("button", { name: "Revoke invitation", exact: true })
    .click();
  await editedInvitation.getByText("revoked", { exact: true }).waitFor();
  await editedInvitation
    .getByRole("button", { name: /^Delete invitation / })
    .click();
  invitationDialog = admin.getByRole("dialog", {
    name: "Delete invitation",
    exact: true,
  });
  await invitationDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(editedInvitation).toBeVisible();
  await editedInvitation
    .getByRole("button", { name: /^Delete invitation / })
    .click();
  await admin.screenshot({
    path: artifacts + "/invitation-delete-confirmation.png",
  });
  const deletedInvitation = admin.waitForResponse(
    (response) =>
      response.url().endsWith("/invitations/" + invitationData.invitation.id) &&
      response.request().method() === "DELETE",
  );
  await invitationDialog
    .getByRole("button", { name: "Delete invitation", exact: true })
    .click();
  assert.equal((await deletedInvitation).status(), 204);
  await expect(editedInvitation).toHaveCount(0);
  mark(
    "Invitation revoke/delete confirmations, cancellation and active deletion refusal passed.",
  );
  const expiring = await admin.evaluate(async (run) => {
    const c = window.__SCORE_CONFIG__;
    const user = JSON.parse(
      sessionStorage.getItem(`score.user.user:${c.issuer}:${c.clientId}`),
    );
    const response = await fetch(c.adminApiUrl + "/invitations", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + user.access_token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "E2E expiring invitation " + run,
        roles: ["member"],
        limit: 1,
        expiresAt: Date.now() + 3000,
      }),
    });
    return { status: response.status, data: await response.json() };
  }, run);
  assert.equal(expiring.status, 201);
  await expect
    .poll(
      async () =>
        admin.evaluate(async (id) => {
          const c = window.__SCORE_CONFIG__;
          const user = JSON.parse(
            sessionStorage.getItem(`score.user.user:${c.issuer}:${c.clientId}`),
          );
          return (
            await (
              await fetch(c.adminApiUrl + "/invitations/" + id, {
                headers: { Authorization: "Bearer " + user.access_token },
              })
            ).json()
          ).state;
        }, expiring.data.invitation.id),
      { timeout: 10000 },
    )
    .toBe("expired");
  await admin.reload();
  const expiredRow = admin
    .getByRole("table", { name: "Invitations", exact: true })
    .getByRole("row")
    .filter({ hasText: "E2E expiring invitation " + run });
  await expect(expiredRow.getByText("expired", { exact: true })).toBeVisible();
  await expiredRow.getByRole("button", { name: /^Delete invitation / }).click();
  await admin
    .getByRole("dialog", { name: "Delete invitation", exact: true })
    .getByRole("button", { name: "Delete invitation", exact: true })
    .click();
  await expect(expiredRow).toHaveCount(0);
  mark("Expired invitation deletion passed without revocation.");
  mark("Invitation creation, expiry-preserving edit and revocation passed.");
  await admin.screenshot({ path: artifacts + "/invitations-table.png" });
  await verifyCatalogueDeletion({ admin, run, artifacts, mark });
  await verifyPaginationSession({ admin, origin, run, artifacts, mark });
  await admin.goto(origin + "/identity/account/");
  await admin
    .getByRole("heading", { name: "Your profile.", exact: true })
    .waitFor({ timeout: 30000 });
  await expect(
    admin.getByRole("link", { name: "Administration", exact: true }),
  ).toBeVisible();
  await expect(admin.getByText("Admin", { exact: true })).toBeVisible();
  mark("SSO across the two public clients passed.");
  await admin.getByRole("button", { name: "Security", exact: true }).click();
  await admin.screenshot({
    path: artifacts + "/security-methods.png",
    fullPage: true,
  });
  const passkeys = admin.getByRole("button", {
    name: "Manage passkeys",
    exact: true,
  });
  await expect(passkeys).toContainText("1 passkey");
  await passkeys.click();
  await admin
    .getByRole("button", { name: "Add passkey", exact: true })
    .waitFor();
  await expect(admin.getByRole("button", { name: /^Remove / })).toBeDisabled();
  await admin.screenshot({
    path: artifacts + "/security-passkeys.png",
    fullPage: true,
  });
  await admin
    .getByRole("button", { name: "Back to sign-in methods", exact: true })
    .click();
  await expect(passkeys).toBeFocused();
  await admin
    .getByRole("button", { name: "Manage authenticator app", exact: true })
    .click();
  await admin.getByRole("button", { name: "Set up app", exact: true }).click();
  await admin.bringToFront();
  await admin.locator("#email").fill(adminEmail);
  await admin.getByRole("button", { name: "Continue", exact: true }).click();
  await admin.locator("#mode-manual").click();
  const totpSecret = await admin.locator("#kc-totp-secret-key").innerText();
  await admin.locator("#totp").fill(authenticatorCode(totpSecret));
  await admin.locator("#userLabel").fill("E2E authenticator");
  await admin.locator("#saveTOTPBtn").click();
  await admin
    .getByRole("button", { name: "Manage authenticator app", exact: true })
    .click();
  await admin.getByText("E2E authenticator", { exact: true }).waitFor();
  mark("Native authenticator-app setup and prefixed return passed.");
  await admin.getByRole("button", { name: "Preferences", exact: true }).click();
  await admin.getByRole("radio").nth(1).click();
  await admin.getByText("Preferences saved.", { exact: true }).waitFor();
  await admin.reload();
  await expect(admin.getByRole("radio").nth(1)).toBeChecked();
  await expect(admin.locator("html")).toHaveClass(/dark/);
  await expect(
    admin.locator("aside").getByRole("button", { name: /Switch to .* mode/ }),
  ).toHaveCount(0);
  await admin.locator('summary[aria-label="Account menu"]').click();
  await expect(
    admin.getByRole("link", { name: "My profile", exact: true }),
  ).toBeVisible();
  await expect(
    admin.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
  await admin.screenshot({
    path: artifacts + "/avatar-menu.png",
    fullPage: true,
  });
  await admin.keyboard.press("Escape");
  await expect(
    admin.getByRole("button", { name: "Sign out", exact: true }),
  ).not.toBeVisible();
  await admin.screenshot({
    path: artifacts + "/account-dark.png",
    fullPage: true,
  });
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.reload();
  await expect(admin.getByRole("radio").nth(1)).toBeChecked();
  await admin.evaluate(() => document.fonts.ready);
  const mobileNavigation = admin.getByRole("button", {
    name: "Toggle navigation",
    exact: true,
  });
  await mobileNavigation.click();
  await expect(mobileNavigation).toHaveAttribute("aria-expanded", "true");
  await admin.getByRole("button", { name: "Preferences", exact: true }).click();
  await expect(mobileNavigation).toHaveAttribute("aria-expanded", "false");
  assert.ok(
    await admin.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "The mobile preferences page must not overflow horizontally.",
  );
  await admin.screenshot({
    path: artifacts + "/account-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await managedApplications.verifyTypeChanges(async () => {
    await admin
      .getByRole("button", {
        name: "Sign in to SCORETech Identity",
        exact: true,
      })
      .waitFor();
    await admin
      .getByRole("button", {
        name: "Sign in to SCORETech Identity",
        exact: true,
      })
      .click();
    await admin.locator("#email").fill(adminEmail);
    await admin.getByRole("button", { name: "Continue", exact: true }).click();
    await admin
      .getByRole("heading", { name: "Connected applications.", exact: true })
      .waitFor({ timeout: 30000 });
  });
  assert.deepEqual(errors, []);
  mark(
    "English-only Spanish-browser flow, dark mode and mobile layout passed.",
  );
  await writeFile(
    artifacts + "/result.json",
    JSON.stringify(
      {
        passed: true,
        checks: [
          "admin-passwordless-passkey",
          "role-publication-and-provider-apply",
          "public-email-registration",
          "profile-persistence",
          "security-sessions",
          "sso-and-denial",
          "delegated-role-assignment-and-passkey",
          "invitation-create-revoke",
          "native-totp-setup",
          "avatar-dropdown-and-security-method-details",
          "application-permission-authoring",
          "managed-oidc-applications-and-secret-lifecycle",
          "editable-application-type-and-session-revocation",
          "oidc-domain-policy-and-live-permission-revocation",
          "english-dark-mobile",
        ],
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  if (admin)
    await admin
      .screenshot({ path: artifacts + "/failure-admin.png", fullPage: true })
      .catch(() => {});
  if (member)
    await member
      .screenshot({ path: artifacts + "/failure-account.png", fullPage: true })
      .catch(() => {});
  throw error;
} finally {
  await browser.close();
  fixture("delete", adminEmail);
  fixture("delete", memberEmail);
}
