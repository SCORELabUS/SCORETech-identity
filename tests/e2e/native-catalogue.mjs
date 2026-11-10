import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
const root = new URL("../../", import.meta.url).pathname;
const compose = [
  "compose",
  "--project-directory",
  root + "docker/development",
  "-f",
  root + "docker/development/compose.yaml",
];
const fixture = String.raw`
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
const realm='http://keycloak:8080/identity/auth/realms/score';
const token=async id=>{const response=await fetch(realm+'/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'client_credentials',client_id:id,client_secret:id==='identity-admin-service'?'fixture-local-admin-service':'fixture-local-account-service'})});assert.equal(response.status,200);return (await response.json()).access_token;};
const admin=await token('identity-admin-service');const account=await token('identity-account-service');
const request=(path='',method='GET',body,bearer=admin)=>fetch(realm+'/score-catalogue'+path,{method,headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const state=async()=>{const response=await request();assert.equal(response.status,200);return response.json();};
const initial=await state();assert.equal(initial.initialized,true);
assert.equal((await request('/projection','GET',undefined,account)).status,200);
assert.equal((await request('','POST',{},account)).status,403);
const name='e2e-native-'+Date.now();
const change=(current,names,reason='Native catalogue regression')=>({baseRevision:current.registry.revision,registry:{...current.registry,generation:current.registry.generation+1,revision:randomBytes(32).toString('hex'),roles:[...current.registry.roles,...names.map(name=>({name,description:'Disposable native regression role',permissions:[]}))]},roleNames:[...current.catalogue.roles.map(role=>role.name),...names],actor:'native-regression',reason,type:'publish'});
const created=await request('','POST',change(initial,[name]));assert.equal(created.status,200);
const active=await state();assert(active.catalogue.roles.some(role=>role.name===name));
const history=await request('/revisions').then(response=>response.json());assert(history.some(entry=>entry.id===active.registry.revision&&entry.reason==='Native catalogue regression'));
assert.equal((await request('/revisions/'+active.registry.revision)).status,200);
assert.equal((await request('','POST',change(initial,[]))).status,409);
// A validation failure after native reconciliation must roll back roles AND history.
const invalid=change(active,[name+'-invalid'],'short');assert.equal((await request('','POST',invalid)).status,400);
assert.equal((await state()).registry.revision,active.registry.revision);
const afterFailure=await request('/revisions').then(response=>response.json());assert(!afterFailure.some(entry=>entry.id===invalid.registry.revision));
const masterResponse=await fetch('http://keycloak:8080/identity/auth/realms/master/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:'fixture-admin',password:'fixture-local-only'})});assert.equal(masterResponse.status,200);const master=(await masterResponse.json()).access_token;
const nativeRole=role=>fetch('http://keycloak:8080/identity/auth/admin/realms/score/roles/'+role,{headers:{Authorization:'Bearer '+master}});
assert.equal((await nativeRole(name+'-invalid')).status,404);
const roleId=(await (await nativeRole(name)).json()).id;
const competing=await Promise.all([request('','POST',change(active,[])),request('','POST',change(active,[]))]);assert.deepEqual(competing.map(response=>response.status).sort(),[200,409]);
const current=await state();const cleanup=change(current,[]);cleanup.roleNames=cleanup.roleNames.filter(role=>role!==name);cleanup.reason='Retire native regression role';assert.equal((await request('','POST',cleanup)).status,200);
const final=await state();assert(!final.catalogue.roles.some(role=>role.name===name));assert.equal((await (await nativeRole(name)).json()).id,roleId);
console.log('Native catalogue: committed state/history, stale writes, concurrent CAS, rollback after validation, retired IDs and read-only account authority passed.');
`;
execFileSync(
  "docker",
  [
    ...compose,
    "exec",
    "-T",
    "account-api",
    "node",
    "--input-type=module",
    "-e",
    fixture,
  ],
  { cwd: root, stdio: "inherit" },
);
const origin = "http://localhost:18000";
const artifacts = root + "test-results/native-catalogue";
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.IDENTITY_E2E_CHROMIUM
    ? {}
    : {
        executablePath:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const kind of ["terms", "privacy"]) {
    const response = await page.goto(origin + "/identity/legal/" + kind);
    assert.equal(response.status(), 200);
    await expect(
      page.getByRole("heading", {
        name: kind === "terms" ? "Terms of service" : "Privacy policy",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("article")).toContainText("infoscore@us.es");
    assert(
      !/TenTuPlaza|Renfe|candidate number|ranking|Mailgun|Amazon Web Services/.test(
        await page.locator("article").innerText(),
      ),
    );
    await page.screenshot({
      path: artifacts + "/" + kind + "-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: artifacts + "/" + kind + "-mobile-dark.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: "light" });
  }
  assert.equal(
    (
      await context.request.get(
        origin + "/identity/legal/assets/source-400.woff2",
      )
    ).status(),
    200,
  );
  assert.equal(
    (
      await context.request.get(
        origin + "/identity/auth/realms/score/score-catalogue",
      )
    ).status(),
    404,
  );
  await context.close();
  console.log(
    "Public legal pages: anonymous access, contact, content, fonts, desktop/mobile/dark layouts and private catalogue routing passed.",
  );
} finally {
  await browser.close();
}
