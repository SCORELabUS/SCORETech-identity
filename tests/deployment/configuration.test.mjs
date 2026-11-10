import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const composeAvailable =
  spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

test("deployment setup preserves existing credentials and creates distinct private values", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "identity-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "docker/production"), { recursive: true });
  await copyFile(
    path.join(root, "docker/setup"),
    path.join(directory, "docker/setup"),
  );
  await copyFile(
    path.join(root, "docker/production/.env.example"),
    path.join(directory, "docker/production/.env.example"),
  );
  const run = () =>
    execFileSync("bash", [path.join(directory, "docker/setup"), "production"], {
      encoding: "utf8",
    });
  run();
  const file = path.join(directory, "docker/production/.env");
  const original = await readFile(file, "utf8");
  const before = await stat(file);
  const secrets = [
    ...original.matchAll(
      /^IDENTITY_(?:DATABASE_PASSWORD|BOOTSTRAP_PASSWORD|ADMIN_CLIENT_SECRET|ACCOUNT_CLIENT_SECRET|SYNC_CLIENT_SECRET)=([a-f0-9]{64})$/gm,
    ),
  ];
  assert.equal(secrets.length, 5);
  assert.equal(new Set(secrets.map((match) => match[1])).size, 5);
  assert.equal(before.mode & 0o777, 0o600);
  assert.match(run(), /Retained existing/);
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal((await stat(file)).ino, before.ino);
  const invalid = spawnSync(
    "bash",
    [path.join(directory, "docker/setup"), "../production"],
    { encoding: "utf8" },
  );
  assert.equal(invalid.status, 2);
});

test(
  "Compose resolves independent environments, private services and ordered first boot",
  { skip: !composeAvailable },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "identity-compose-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const models = {};
    for (const environment of ["development", "staging", "production"]) {
      let env = await readFile(
        path.join(root, `docker/${environment}/.env.example`),
        "utf8",
      );
      env = env.replace(
        /^IDENTITY_GITHUB_KEY_FILE=.*$/m,
        `IDENTITY_GITHUB_KEY_FILE=${directory}/key.pem`,
      );
      // Config inspection does not read/contact providers or start services.
      await writeFile(path.join(directory, "key.pem"), "synthetic-config-only");
      const envFile = path.join(directory, `${environment}.env`);
      await writeFile(envFile, env);
      const result = execFileSync(
        "docker",
        [
          "compose",
          "--env-file",
          envFile,
          "-f",
          path.join(root, `docker/${environment}/compose.yaml`),
          "config",
          "--format",
          "json",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const model = (models[environment] = JSON.parse(result));
      for (const service of [
        "database",
        "keycloak",
        "account-api",
        "admin-api",
      ]) {
        assert.equal(
          model.services[service].ports,
          undefined,
          `${environment}/${service} stays private`,
        );
      }
      assert.equal(model.services.gateway.ports[0].host_ip, "127.0.0.1");
      for (const service of Object.values(model.services)) {
        for (const volume of service.volumes || []) {
          assert.ok(
            !volume.source.endsWith("/authorization.lock"),
            "mount the coordination directory before init creates the lock",
          );
        }
      }
      if (environment === "development") {
        assert.equal(model.services.keycloak.build.context, root);
        assert.equal(
          model.services.keycloak.depends_on.prepare.condition,
          "service_completed_successfully",
        );
        assert.equal(
          model.services["catalogue-init"].depends_on.bootstrap.condition,
          "service_completed_successfully",
        );
        assert.equal(
          model.volumes["identity-database"].name,
          "scoretech-identity-lab_identity-database",
        );
        continue;
      }
      const images = {
        render: "tooling",
        "realm-setup": "tooling",
        "catalogue-init": "tooling",
        keycloak: "provider",
        "account-api": "account",
        "admin-api": "admin",
        gateway: "gateway",
      };
      for (const [service, suffix] of Object.entries(images)) {
        assert.equal(
          model.services[service].build,
          undefined,
          "Production never needs a source build",
        );
        assert.equal(model.services[service].pull_policy, "always");
        assert.equal(
          model.services[service].image,
          `ghcr.io/scorelabus/scoretech-identity-${suffix}:main`,
        );
      }
      assert.ok(
        !model.services.gateway.volumes.some(
          (v) => v.target === "/etc/nginx/conf.d/default.conf",
        ),
        "Gateway configuration travels with its versioned image",
      );
      assert.equal(
        model.services.keycloak.depends_on.render.condition,
        "service_completed_successfully",
      );
      assert.equal(
        model.services["catalogue-init"].depends_on["realm-setup"].condition,
        "service_completed_successfully",
      );
      assert.deepEqual(
        Object.keys(model.services).filter(
          (name) => "sphere" in model.services[name].networks,
        ),
        ["gateway"],
      );
      assert.equal(model.networks.sphere.external, true);
      assert.equal(
        model.services["account-api"].environment.APP_KEYCLOAK_ISSUER,
        `${model.services.render.environment.IDENTITY_PUBLIC_ORIGIN}/identity/auth/realms/score`,
      );
      assert.equal(
        model.services["account-api"].environment
          .APP_KEYCLOAK_ADMIN_CLIENT_SECRET,
        undefined,
      );
      assert.equal(
        model.secrets.account_client.environment,
        "IDENTITY_ACCOUNT_CLIENT_SECRET",
      );
      assert.equal(model.services.render.profiles, undefined);
      assert.equal(model.services["catalogue-init"].profiles, undefined);
    }
    assert.equal(
      models.production.volumes["identity-database"].name,
      "scoretech-identity_identity-database",
    );
    assert.equal(
      new Set(
        Object.values(models).map((m) => m.volumes["identity-database"].name),
      ).size,
      3,
    );
    assert.equal(
      new Set(
        Object.values(models).map((m) => m.volumes["identity-avatars"].name),
      ).size,
      3,
    );
    assert.equal(
      new Set(
        Object.values(models).map(
          (m) => (m.services.render || m.services.prepare).volumes[0].source,
        ),
      ).size,
      3,
    );
  },
);
