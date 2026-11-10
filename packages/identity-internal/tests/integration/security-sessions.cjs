// Local fixtures only. Run after provider and both local APIs/webs are ready.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const assert = require('node:assert/strict');
const base = 'http://localhost:18080',
  realm = 'tentuplaza';
(async () => {
  const bootstrap = await fetch(base + '/realms/master/protocol/openid-connect/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'fixture-admin',
      password: 'fixture-local-only',
    }),
  }).then((r) => r.json());
  async function admin(path, method = 'GET', body) {
    const r = await fetch(base + '/admin/realms/' + realm + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + bootstrap.access_token,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(r.ok, 'Local fixture admin ' + r.status);
    const text = await r.text();
    return text ? JSON.parse(text) : undefined;
  }
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_EXECUTABLE ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const fixtureIds = [];
  async function createUser(prefix, roles = []) {
    const email = prefix + '-' + Date.now() + '@example.invalid';
    await admin('/users', 'POST', {
      username: email,
      email,
      emailVerified: true,
      enabled: true,
      firstName: 'Session',
      lastName: 'Fixture',
      realmRoles: roles,
    });
    const user = (await admin('/users?email=' + encodeURIComponent(email)))[0];
    fixtureIds.push(user.id);
    if (roles.length) {
      const definitions = await admin('/roles');
      await admin(
        '/users/' + user.id + '/role-mappings/realm',
        'POST',
        definitions.filter((role) => roles.includes(role.name)),
      );
    }
    return user;
  }
  async function otp(page, email) {
    await page.locator('#email').fill(email);
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await page.locator('#code').waitFor();
    const inbox = await fetch('http://localhost:18025/api/v1/messages').then((r) => r.json());
    const item = inbox.messages.find((m) => m.To.some((to) => to.Address === email));
    assert.ok(item, 'Fixture email delivered');
    const mail = await fetch('http://localhost:18025/api/v1/message/' + item.ID).then((r) =>
      r.json(),
    );
    await page.locator('#code').fill(mail.Text.match(/\b\d{6}\b/)[0]);
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  }
  async function token(page, storage = 'sessionStorage') {
    return page.evaluate((storage) => {
      const store = window[storage];
      const key = Object.keys(store).find((key) => key.startsWith('oidc.user:'));
      return JSON.parse(store.getItem(key)).access_token;
    }, storage);
  }
  async function call(port, path, token) {
    const r = await fetch('http://localhost:' + port + path, {
      headers: { Authorization: 'Bearer ' + token },
    });
    const body = await r.json();
    return { status: r.status, body };
  }
  try {
    const person = await createUser('session-normal');
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await desktop.newPage();
    await page.goto('http://localhost:5174');
    await otp(page, person.email);
    await page.waitForURL('http://localhost:5174/');
    const firstToken = await token(page);
    await fetch('http://localhost:8081/v1/account/security/passkey-suggestion', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + firstToken },
    });
    await page.reload();
    await page.getByRole('button', { name: 'Dispositivos y sesiones', exact: true }).click();
    await page.getByText('Esta sesión', { exact: true }).waitFor();
    const one = await call(8081, '/v1/account/sessions', firstToken);
    assert.equal(one.status, 200);
    assert.equal(one.body.sessions.length, 1);
    assert.equal(one.body.sessions[0].current, true);
    assert.match(one.body.sessions[0].browser, /Chrome/);
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    });
    const second = await mobile.newPage();
    await second.goto('http://localhost:5174');
    await otp(second, person.email);
    await second.waitForURL('http://localhost:5174/');
    const secondToken = await token(second);
    const two = await call(8081, '/v1/account/sessions', secondToken);
    assert.equal(two.status, 200);
    assert.equal(two.body.sessions.length, 2);
    assert.equal(two.body.sessions.filter((s) => s.current).length, 1);
    assert.equal(two.body.sessions.find((s) => s.current).device, 'Móvil');
    assert.ok(
      two.body.sessions.some((s) => !s.current && s.browser),
      'Stored browser data for previous context',
    );
    const session = two.body.sessions.find((s) => s.current);
    const activity = await call(
      8081,
      '/v1/account/sessions/' + session.id + '/activity',
      secondToken,
    );
    assert.equal(activity.status, 200);
    assert.ok(activity.body.events.some((e) => e.type === 'LOGIN'));
    assert.ok(activity.body.applications.includes('identity-account-web'));
    assert.ok(!JSON.stringify(activity.body).includes('user_agent'));
    assert.ok(!JSON.stringify(activity.body).includes('code_id'));
    await page.reload();
    await page.getByRole('button', { name: 'Dispositivos y sesiones', exact: true }).click();
    await page.getByRole('button', { name: 'Ver aplicaciones y actividad' }).first().click();
    await page.getByText('Actividad de identidad', { exact: true }).waitFor();
    await page.screenshot({ path: '/tmp/tentuid-sessions-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: '/tmp/tentuid-sessions-mobile.png', fullPage: true });
    const other = await createUser('session-admin', [
      'administrador',
      'identity:administrator',
      'identity-admin:staging:access',
      'identity:users:view',
      'identity:roles:view',
    ]);
    const ac = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const ap = await ac.newPage();
    const cdp = await ac.newCDPSession(ap);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    ap.on('dialog', (d) => d.accept('Session monitoring key'));
    await ap.goto('http://localhost:5173');
    await otp(ap, other.email);
    try {
      await ap.locator('#registerWebAuthn').waitFor();
    } catch (error) {
      console.log('Admin fixture page:', await ap.locator('body').innerText());
      throw error;
    }
    await ap.locator('#registerWebAuthn').click();
    await ap.waitForURL('http://localhost:5173/');
    const adminToken = await token(ap, 'localStorage');
    const monitoring = await call(8080, '/v1/security-events?type=LOGIN&max=50', adminToken);
    assert.equal(monitoring.status, 200);
    assert.ok(monitoring.body.events.length > 0);
    assert.ok(monitoring.body.events.every((e) => e.type === 'LOGIN'));
    assert.equal((await call(8080, '/v1/security-events', secondToken)).status, 401);
    const otherSession = (await admin('/users/' + other.id + '/sessions'))[0];
    assert.equal(
      (await call(8081, '/v1/account/sessions/' + otherSession.id + '/activity', secondToken))
        .status,
      404,
    );
    await ap.getByRole('button', { name: 'Eventos de seguridad', exact: true }).click();
    await ap.getByRole('heading', { name: 'Eventos de seguridad' }).waitFor();
    await ap.getByRole('cell', { name: 'LOGIN', exact: true }).first().waitFor();
    await ap.screenshot({ path: '/tmp/tentuid-admin-events-desktop.png', fullPage: true });
    await ap.setViewportSize({ width: 390, height: 844 });
    assert.ok(await ap.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await ap.screenshot({ path: '/tmp/tentuid-admin-events-mobile.png', fullPage: true });
    console.log(
      'PASS: two real browser sessions, signed current-session marker, persisted device metadata, own-session events/applications, foreign-session rejection, administrative monitor and desktop/mobile layouts',
    );
  } finally {
    await browser.close();
    for (const id of fixtureIds) await admin('/users/' + id, 'DELETE');
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
