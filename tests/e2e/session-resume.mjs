import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
const root = new URL("../../", import.meta.url).pathname;
const origin = "http://localhost:18000";
const adminEmail = `e2e-admin-${Date.now()}@example.invalid`;
const artifacts = root + "test-results/session";
await mkdir(artifacts, { recursive: true });
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
const context = await browser.newContext();
const errors = [];
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

try {
  fixture("create", adminEmail);
  const page = await attach(context);
  await page.goto(origin + "/identity/admin/");
  await page
    .getByRole("button", { name: "Sign in to SCORETech Identity", exact: true })
    .click();
  await page.locator("#email").fill(adminEmail);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator("#code").fill(await code(adminEmail, page));
  await page.locator("#registerWebAuthn").click();
  await expect(
    page.getByRole("heading", {
      name: "People power the ecosystem.",
      exact: true,
    }),
  ).toBeVisible({ timeout: 30000 });
  await page.goto(origin + "/identity/account/");
  await expect(
    page.getByRole("heading", { name: "Your profile.", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByRole("button", {
      name: "Sign in to SCORETech Identity",
      exact: true,
    }),
  ).toHaveCount(0);
  // A fresh client tab has no console token; it must reuse the existing SSO cookie.
  const admin = await attach(context);
  await admin.goto(origin + "/identity/admin/#users");
  await expect(
    admin.getByRole("heading", {
      name: "People power the ecosystem.",
      exact: true,
    }),
  ).toBeVisible({ timeout: 30000 });
  const search = admin.getByLabel("Search users", { exact: true });
  // Use the actual directory search label from the UI if it differs.
  const input = admin.locator(".toolbar input");
  await input.fill("session-resume-proof");
  const issuer = origin + "/identity/auth/realms/score";
  const tokenUrl = issuer + "/protocol/openid-connect/token";
  async function expireAndWake() {
    await admin.evaluate(() => {
      const c = window.__SCORE_CONFIG__;
      const key = `score.user.user:${c.issuer}:${c.clientId}`;
      const u = JSON.parse(sessionStorage.getItem(key));
      u.expires_at = Math.floor(Date.now() / 1000) - 10;
      sessionStorage.setItem(key, JSON.stringify(u));
      window.dispatchEvent(new Event("focus"));
    });
  }
  let renewed = admin.waitForResponse(
    (r) =>
      r.url() === tokenUrl &&
      r.ok() &&
      r.request().postData()?.includes("grant_type=refresh_token"),
  );
  await expireAndWake();
  await renewed;
  await expect(input).toHaveValue("session-resume-proof");
  // The local refresh is rejected while the native SSO session remains active.
  let rejected = false;
  await admin.route(tokenUrl, async (route) => {
    if (
      !rejected &&
      new URLSearchParams(route.request().postData()).get("grant_type") ===
        "refresh_token"
    ) {
      rejected = true;
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "invalid_grant" }),
      });
    } else await route.continue();
  });
  renewed = admin.waitForResponse(
    (r) =>
      r.url() === tokenUrl &&
      r.ok() &&
      r.request().postData()?.includes("grant_type=authorization_code"),
  );
  await expireAndWake();
  await renewed;
  await admin.unroute(tokenUrl);
  assert.ok(rejected);
  await expect(input).toHaveValue("session-resume-proof");
  assert.equal(admin.url(), origin + "/identity/admin/#users");
  await expect(
    admin.getByRole("button", {
      name: "Sign in to SCORETech Identity",
      exact: true,
    }),
  ).toHaveCount(0);
  await admin.screenshot({ path: artifacts + "/session-preserved.png" });
  // A browser with no native session must show the normal sign-in screen, without a loop.
  const anonymous = await browser.newContext();
  const guest = await anonymous.newPage();
  let attempts = 0;
  guest.on("request", (r) => {
    if (r.url().includes("/protocol/openid-connect/auth?")) attempts++;
  });
  await guest.goto(origin + "/identity/admin/");
  await expect(
    guest.getByRole("button", {
      name: "Sign in to SCORETech Identity",
      exact: true,
    }),
  ).toBeVisible({ timeout: 30000 });
  assert.equal(attempts, 1);
  await anonymous.close();
  await writeFile(
    artifacts + "/result.json",
    JSON.stringify({
      crossConsoleSso: true,
      backgroundResume: true,
      refreshRecoveryViaSso: true,
      routeAndSearchPreserved: true,
      noAnonymousLoop: true,
    }),
  );
  console.log(
    "Session recovery: cross-console SSO, focus refresh, rejected refresh recovery and anonymous fallback passed.",
  );
} finally {
  await browser.close();
  fixture("delete", adminEmail);
}
