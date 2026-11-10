import { verifyConnectedIdentities } from "./connected-identities.mjs";
// Isolated local CAS broker E2E; no real US/Google credentials or gateway changes.
import { chromium, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import http from "node:http";
const root = new URL("../../", import.meta.url).pathname;
const compose = [
  "compose",
  "--project-directory",
  root,
  "-f",
  root + "deploy/local/compose.yaml",
];
const container = execFileSync("docker", [...compose, "ps", "-q", "keycloak"], {
  encoding: "utf8",
}).trim();
if (!container) throw Error("Start ./lab up first.");
const fixtureName = "score-cas-e2e-fixture";
const fixture = spawn(
  "docker",
  [
    "run",
    "--rm",
    "--name",
    fixtureName,
    "--network",
    "container:" + container,
    "-v",
    root + "tests/e2e/cas-fixture.mjs:/fixture.mjs:ro",
    "scoretech-identity-tooling:local",
    "node",
    "/fixture.mjs",
  ],
  { stdio: "ignore" },
);
const run = Date.now();
const email = `cas-fixture-${run}@example.invalid`;
const api = (code) =>
  JSON.parse(
    execFileSync(
      "docker",
      [
        ...compose,
        "exec",
        "-T",
        "catalogue-fixture",
        "node",
        "--input-type=module",
        "-e",
        `const base='http://keycloak:8080/identity/auth';const r=await fetch(base+'/realms/master/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:'fixture-admin',password:'fixture-local-only'})});if(!r.ok)throw Error('Fixture auth failed');const {access_token}=await r.json();const call=async(path,method='GET',body)=>{const r=await fetch(base+'/admin/realms/score'+path,{method,headers:{Authorization:'Bearer '+access_token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error('Fixture request '+r.status);const text=await r.text();return text?JSON.parse(text):null;};${code}`,
      ],
      { encoding: "utf8" },
    ),
  );
const loginFixture = http.createServer((req, res) => {
  const target = new URL(
    new URL(req.url, "http://localhost:18899").searchParams.get("service"),
  );
  target.searchParams.set("ticket", "ST-fixture-" + run);
  res.writeHead(302, { Location: target.href });
  res.end();
});
await new Promise((resolve) =>
  loginFixture.listen(18899, "127.0.0.1", resolve),
);
let browser;
let page;
let previousProvider;
try {
  previousProvider = api(
    "const providers=await call('/identity-provider/instances');console.log(JSON.stringify(providers.find(p=>p.alias==='us-sso')||null));",
  );
  api(
    `await call('/identity-provider/instances${previousProvider ? "/us-sso" : ""}','${previousProvider ? "PUT" : "POST"}',{alias:'us-sso',providerId:'score-us-cas',displayName:'US fixture',enabled:true,trustEmail:false,storeToken:false,firstBrokerLoginFlowAlias:'score-first-broker-login-v1',postBrokerLoginFlowAlias:'score-post-broker-login',config:{casUrl:'http://localhost:18899',callbackUrl:'http://localhost:18000/api/v1/users/auth/sso/us/callback'}});console.log('null');`,
  );
  api(
    `await call('/identity-provider/instances','POST',{alias:'google-fixture',providerId:'google',displayName:'Google fixture',enabled:true,trustEmail:false,storeToken:false,firstBrokerLoginFlowAlias:'score-first-broker-login-v1',postBrokerLoginFlowAlias:'score-post-broker-login',config:{clientId:'fixture-only',clientSecret:'fixture-only',defaultScope:'openid email profile'}});console.log('null');`,
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.IDENTITY_E2E_CHROMIUM
      ? {}
      : {
          executablePath:
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        }),
  });
  const context = await browser.newContext();
  page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.goto("http://localhost:18000/identity/account/");
  await page.getByRole("button", { name: /Sign in/ }).click();
  const googleLink = page.getByRole("link", {
    name: "Continue with Google fixture",
    exact: true,
  });
  await expect(googleLink).toHaveCSS("color", "rgb(31, 31, 31)");
  await expect(page.locator("#social-us-sso")).toHaveCSS(
    "color",
    "rgb(255, 255, 255)",
  );
  await mkdir(root + "test-results/external-sso", { recursive: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    timeout: 5000,
    animations: "disabled",
    path: root + "test-results/external-sso/login-providers-dark.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    timeout: 5000,
    animations: "disabled",
    path: root + "test-results/external-sso/login-providers-mobile.png",
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ colorScheme: "light" });
  const googleResponse = await page.request.get(
    new URL(await googleLink.getAttribute("href"), page.url()).href,
    { maxRedirects: 0 },
  );
  assert.equal(googleResponse.status(), 303);
  const googleAuthorization = new URL(googleResponse.headers().location);
  assert.equal(googleAuthorization.hostname, "accounts.google.com");
  assert.equal(
    googleAuthorization.searchParams.get("client_id"),
    "fixture-only",
  );
  assert.equal(
    googleAuthorization.searchParams.get("redirect_uri"),
    "http://localhost:18000/identity/auth/realms/score/broker/google-fixture/endpoint",
  );
  await page.reload();
  await page
    .getByRole("link", { name: "Continue with US fixture", exact: true })
    .click();
  // Native broker profile review may require confirmation before consent.
  await page.waitForLoadState("networkidle");
  if (await page.locator("#kc-update-profile-form").count())
    await page.locator("#kc-update-profile-form input[type=submit]").click();

  await mkdir(root + "test-results/external-sso", { recursive: true });
  await page.screenshot({
    timeout: 5000,
    animations: "disabled",
    path: root + "test-results/external-sso/broker-step.png",
  });
  await expect(
    page.getByRole("heading", { name: "Complete your account" }),
  ).toBeVisible();
  await page.locator("#terms").check();
  await page.locator("#privacy").check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your profile.", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  const user = api(
    `const users=await call('/users?email='+encodeURIComponent(${JSON.stringify(email)})+'&exact=true');console.log(JSON.stringify(users[0]));`,
  );
  assert.equal(user.emailVerified, false);
  assert.ok(user.attributes.tentuTermsVersion);
  const roles = api(
    `console.log(JSON.stringify(await call('/users/${user.id}/role-mappings/realm')));`,
  );
  assert.ok(roles.some((r) => r.name === "member"));
  assert.ok(!roles.some((r) => r.name === "administrador"));
  // Pending email actions from the previous implementation must not trap linked SSO users.
  api(
    `await call('/users/${user.id}','PUT',{requiredActions:['VERIFY_EMAIL']});console.log('null');`,
  );
  const returning = await page.context().newPage();
  await returning.goto("http://localhost:18000/identity/account/");
  await expect(
    returning.getByRole("heading", { name: "Your profile.", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  const updated = api(
    `console.log(JSON.stringify(await call('/users/${user.id}')));`,
  );
  assert.equal(updated.emailVerified, false);
  assert.ok(!updated.requiredActions.includes("VERIFY_EMAIL"));
  await returning.close();
  const messages = await fetch("http://localhost:18025/api/v1/messages").then(
    (r) => r.json(),
  );
  assert.ok(
    !messages.messages?.some((m) => m.To.some((to) => to.Address === email)),
    "Broker sign-in must not send another verification email",
  );
  await page.screenshot({
    timeout: 5000,
    animations: "disabled",
    path: root + "test-results/external-sso/cas-account.png",
  });
  await verifyConnectedIdentities({ page, browser, email, user, api, root });
  await writeFile(
    root + "test-results/external-sso/result.json",
    JSON.stringify({
      googleAuthorizationRequest: true,
      casNativeBroker: true,
      consent: true,
      noRedundantEmailVerification: true,
      returningUserPendingActionCleared: true,
      memberRole: true,
      noAdminGrant: true,
      accountSessionAfterCas: true,
      connectedIdentities: true,
    }),
  );
  console.log(
    "CAS broker, profile, consent, no redundant verification and baseline role passed.",
  );
} finally {
  await browser?.close();
  loginFixture.closeAllConnections();
  await new Promise((resolve) => loginFixture.close(resolve));
  try {
    api(
      `await call('/identity-provider/instances/google-fixture','DELETE');for(const u of await call('/users?email='+encodeURIComponent(${JSON.stringify(email)})+'&exact=true')){if(u.email===${JSON.stringify(email)})await call('/users/'+u.id,'DELETE');}${previousProvider ? `await call('/identity-provider/instances/us-sso','PUT',${JSON.stringify(previousProvider)});` : `await call('/identity-provider/instances/us-sso','DELETE');`}console.log('null');`,
    );
  } finally {
    try {
      execFileSync("docker", ["stop", fixtureName], { stdio: "ignore" });
    } catch {}
    fixture.kill();
  }
}
