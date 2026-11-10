import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
const root = new URL("../../", import.meta.url).pathname;
const origin = "http://localhost:18000";
const email = `e2e-account-${Date.now()}@example.invalid`;
const artifacts = root + "test-results/account-profile";
await mkdir(artifacts, { recursive: true });
function fixture(action) {
  assert.match(email, /^e2e-account-\d+@example\.invalid$/);
  const script = `const base='http://keycloak:8080/identity/auth';const login=await fetch(base+'/realms/master/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:'fixture-admin',password:'fixture-local-only'})});if(!login.ok)throw Error('Fixture authentication failed');const {access_token}=await login.json();const headers={Authorization:'Bearer '+access_token,'Content-Type':'application/json'};const url=base+'/admin/realms/score';const email=${JSON.stringify(email)};const action=${JSON.stringify(action)};const users=async()=>{const r=await fetch(url+'/users?email='+encodeURIComponent(email)+'&exact=true',{headers});if(!r.ok)throw Error('Fixture lookup failed');return r.json();};if(action==='create'){const r=await fetch(url+'/users',{method:'POST',headers,body:JSON.stringify({username:email,email,firstName:'Profile',lastName:'Tester',enabled:true,emailVerified:true})});if(r.status!==201)throw Error('Fixture creation failed');}else if(action==='check-deleted'){if((await users()).length)throw Error('Native identity was not deleted');}else{for(const user of await users()){if(user.email!==email)throw Error('Unsafe fixture cleanup');const r=await fetch(url+'/users/'+user.id,{method:'DELETE',headers});if(!r.ok)throw Error('Cleanup failed');}}`;
  execFileSync(
    "docker",
    [
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
      script,
    ],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
  );
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
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const consumed = new Set();
async function signInCode() {
  await page.locator("#email").fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator("#code").waitFor();
  for (let attempt = 0; attempt < 400; attempt++) {
    const data = await fetch("http://localhost:18025/api/v1/messages").then(
      (r) => r.json(),
    );
    const message = data.messages?.find(
      (m) => !consumed.has(m.ID) && m.To.some((to) => to.Address === email),
    );
    if (message) {
      const detail = await fetch(
        "http://localhost:18025/api/v1/message/" + message.ID,
      ).then((r) => r.json());
      const code = (detail.Text || "").match(/\b[0-9]{6}\b/);
      if (code) {
        consumed.add(message.ID);
        await page.locator("#code").fill(code[0]);
        return;
      }
    }
    if (attempt > 4 && attempt % 8 === 0) {
      const resend = page.getByRole("button", {
        name: "Resend code",
        exact: true,
      });
      if (await resend.isEnabled().catch(() => false)) await resend.click();
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw Error("No captured fixture sign-in code");
}
async function openProfile() {
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Profile and avatar", exact: true }),
  ).toBeVisible();
}
async function editAvatar() {
  await page
    .getByRole("button", { name: "Edit avatar", exact: true })
    .first()
    .click();
}
try {
  fixture("create");
  await page.goto(origin + "/identity/account/");
  await page
    .getByRole("button", { name: "Sign in to SCORETech Identity", exact: true })
    .click();
  await signInCode();
  await expect(
    page.getByRole("heading", { name: "Your profile.", exact: true }),
  ).toBeVisible();
  await page.locator('summary[aria-label="Account menu"]').click();
  await page.getByRole("link", { name: "My profile", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Profile and avatar", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Display name", { exact: true })
    .fill("SCORE Researcher");
  await page
    .getByLabel("Bio", { exact: true })
    .fill("A shared profile across SCORE.");
  await page.getByLabel("City", { exact: true }).fill("Sevilla");
  await page.getByLabel("Country", { exact: true }).fill("Spain");
  await page.getByLabel("Date of birth", { exact: true }).fill("1990-01-01");
  await page
    .getByLabel("LinkedIn", { exact: true })
    .fill("https://linkedin.com/in/score-researcher");
  await page
    .getByLabel("X (Twitter)", { exact: true })
    .fill("https://x.com/score_research");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(
    page.getByText("Your shared profile has been updated.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "SCORE Researcher",
  );
  await expect(page.getByLabel("X (Twitter)", { exact: true })).toHaveValue(
    "https://x.com/score_research",
  );
  await expect(page.locator(".identity-card strong")).toHaveText(
    "SCORE Researcher",
  );
  await editAvatar();
  await page.getByRole("button", { name: "Predefined", exact: true }).click();
  await page.getByRole("button", { name: "Next avatars", exact: true }).click();
  await page.getByRole("button", { name: "Robot", exact: true }).click();
  await page
    .getByRole("button", { name: "Background #be1d37", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Foreground #ffffff", exact: true })
    .click();
  await page.getByRole("button", { name: "Save avatar", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".identity-card .user-avatar img")).toHaveAttribute(
    "src",
    /^data:image\/svg/,
  );
  await editAvatar();
  await page.getByRole("button", { name: "Initials", exact: true }).click();
  await page.mouse.click(5, 5);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".identity-card .user-avatar img")).toHaveAttribute(
    "src",
    /^data:image\/svg/,
  );
  console.log("Shared profile and predefined avatar persistence passed.");
  // A real PNG is cropped in the browser and decoded/re-encoded again by Account API.
  const image = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 300;
      const context = canvas.getContext("2d");
      context.fillStyle = "#be1d37";
      context.fillRect(0, 0, 400, 300);
      context.fillStyle = "#ffffff";
      context.font = "bold 120px sans-serif";
      context.textAlign = "center";
      context.fillText("PT", 200, 195);
      return canvas.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  await editAvatar();
  await page.locator("input[type=file]").setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: image,
  });
  await expect(
    page.getByRole("dialog", { name: "Crop your avatar", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Zoom", { exact: true }).press("ArrowRight");
  await page.getByRole("button", { name: "Save image", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".identity-card .user-avatar img")).toHaveAttribute(
    "src",
    /^data:image\/webp;base64/,
  );
  await page.reload();
  await expect(page.locator(".identity-card .user-avatar img")).toHaveAttribute(
    "src",
    /^data:image\/webp;base64/,
  );
  await page.screenshot({
    path: artifacts + "/profile-light.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await page.getByRole("radio", { name: "Dark mode", exact: true }).check();
  await openProfile();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: artifacts + "/profile-mobile-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await editAvatar();
  await page.getByRole("button", { name: "Predefined", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: artifacts + "/avatar-mobile-dark.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await editAvatar();
  await page
    .getByRole("button", { name: "Remove avatar", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Remove your avatar?", exact: true })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Edit avatar", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Remove avatar", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove avatar", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".identity-card .user-avatar img")).toHaveCount(0);

  console.log(
    "Photo cropping, removal, mobile/dark mode and dialog dismissal passed.",
  );
  await page.getByRole("button", { name: "Danger zone", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete my identity", exact: true })
    .click();
  await page.mouse.click(5, 5);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Delete my identity", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Continue to verification", exact: true })
    .click();
  await signInCode();
  await page
    .getByLabel("Type " + email + " to confirm", { exact: true })
    .fill("wrong@example.invalid");
  await page
    .getByRole("button", { name: "Delete my identity", exact: true })
    .click();
  await expect(
    page.getByText("Type your email address to confirm deletion.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel("Type " + email + " to confirm", { exact: true })
    .fill(email);
  await page
    .getByRole("button", { name: "Delete my identity", exact: true })
    .click();
  await expect(
    page.getByText(
      "Your SCORETech Identity account has been deleted. Your data in other SCORE services must be managed separately.",
      { exact: true },
    ),
  ).toBeVisible();
  fixture("check-deleted");
  assert.deepEqual(errors, []);
  await writeFile(
    artifacts + "/result.json",
    JSON.stringify({
      profilePersistence: true,
      socialLinks: true,
      sphereAvatarPicker: true,
      photoCropAndStorage: true,
      sidebarUpdates: true,
      mobileDark: true,
      nativeConfirmedDeletion: true,
    }),
  );
  console.log(
    "Account profile: shared details, social links, SPHERE avatar editor, private photos, mobile/dark mode and confirmed native deletion passed.",
  );
} catch (error) {
  await page
    .screenshot({ path: artifacts + "/failure.png", fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
  fixture("delete");
}
