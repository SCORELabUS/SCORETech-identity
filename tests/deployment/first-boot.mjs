// Disposable first boot using the real lab images, without touching .lab or its volumes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  statSync,
  realpathSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const project = `identity-first-boot-${process.pid}`;
const directory = realpathSync(mkdtempSync(path.join(tmpdir(), project + "-")));
const file = path.join(directory, "compose.json");
const runtime = path.join(directory, "runtime");
const run = (...args) =>
  execFileSync("docker", ["compose", "-p", project, "-f", file, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
let configured = false;
try {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const source = execFileSync(
    "docker",
    [
      "compose",
      "--env-file",
      "/dev/null",
      "-f",
      path.join(root, "docker/development/compose.yaml"),
      "config",
      "--format",
      "json",
    ],
    { encoding: "utf8" },
  );
  const model = JSON.parse(source);
  const previousOrigin =
    model.services.prepare.environment.IDENTITY_PUBLIC_ORIGIN;
  const isolated = JSON.parse(
    JSON.stringify(model).replaceAll(
      previousOrigin,
      `http://localhost:${port}`,
    ),
  );
  isolated.name = project;
  // Fully resolved Compose models include explicit names; remove them before use.
  for (const volume of Object.values(isolated.volumes)) delete volume.name;
  for (const network of Object.values(isolated.networks)) delete network.name;
  for (const service of Object.values(isolated.services)) {
    for (const volume of service.volumes || []) {
      if (volume.type !== "bind") continue;
      assert.ok(
        volume.source.startsWith(path.join(root, ".lab")),
        "Only lab runtime binds may be redirected",
      );
      volume.source =
        runtime + volume.source.slice(path.join(root, ".lab").length);
    }
  }
  isolated.services.gateway.ports[0].published = String(port);
  delete isolated.services.mail.ports;
  mkdirSync(runtime);
  writeFileSync(file, JSON.stringify(isolated));
  configured = true;
  run("up", "-d", "--wait", "--wait-timeout", "300");
  console.log(
    run(
      "run",
      "--rm",
      "--no-deps",
      "-e",
      "SMOKE_ORIGIN=http://gateway:18000",
      "--entrypoint",
      "node",
      "prepare",
      "tooling/smoke.mjs",
    ).trim(),
  );
  const lock = path.join(runtime, "coordination/authorization.lock");
  const before = statSync(lock).ino;
  run("up", "-d", "--wait", "--wait-timeout", "300");
  assert.equal(
    statSync(lock).ino,
    before,
    "Repeated startup preserves the shared lock inode",
  );
  console.log(
    "PASS empty runtime first boot, HTTP boundaries and repeat startup without resetting state",
  );
} catch (error) {
  console.error(error.message);
  if (error.stderr) console.error(String(error.stderr));
  if (configured) {
    try {
      console.error(run("logs", "--tail=40"));
    } catch {}
  }
  process.exitCode = 1;
} finally {
  if (process.env.IDENTITY_KEEP_DEPLOYMENT_TEST && process.exitCode) {
    console.log(
      `Retained disposable failure fixture: ${directory} (${project})`,
    );
  } else {
    if (configured) {
      // These names/volumes were created by this test only, never the existing lab.
      try {
        run("down", "--volumes", "--remove-orphans");
      } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
      }
    }
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      if (!["EACCES", "EPERM"].includes(error.code)) throw error;
      // Linux renderers chown private fixture files to UID 1000. Remove only the
      // disposable runtime through its parent mount, with no network or other binds.
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--user",
          "0:0",
          "--network",
          "none",
          "--mount",
          `type=bind,source=${directory},target=/fixture`,
          "--entrypoint",
          "node",
          "scoretech-identity-tooling:local",
          "-e",
          "require('node:fs').rmSync('/fixture/runtime',{recursive:true,force:true})",
        ],
        { stdio: "ignore" },
      );
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
