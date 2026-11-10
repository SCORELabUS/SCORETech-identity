import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (file) => readFile(path.join(root, file), "utf8");

test("publication gate rejects other events and skips superseded main commits", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "identity-publish-gate-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workflow = parse(await read(".github/workflows/publish-images.yml"));
  const gate = workflow.jobs.release.steps.find(
    (step) => step.id === "release",
  ).run;
  await writeFile(
    path.join(directory, "gh"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$SYNTHETIC_MAIN_SHA"\n',
    { mode: 0o700 },
  );
  const output = path.join(directory, "outputs");
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "SCORELabUS/SCORETech-identity",
    GITHUB_SHA: "a".repeat(40),
    SYNTHETIC_MAIN_SHA: "a".repeat(40),
    GITHUB_OUTPUT: output,
  };
  for (const [changes, expectedStatus, expectedOutput] of [
    [{}, 0, "publish=true\nprefix=ghcr.io/scorelabus/scoretech-identity\n"],
    [{ SYNTHETIC_MAIN_SHA: "b".repeat(40) }, 0, "publish=false\n"],
    [{ GITHUB_EVENT_NAME: "pull_request" }, 1, ""],
    [{ GITHUB_REF: "refs/heads/develop" }, 1, ""],
  ]) {
    await writeFile(output, "");
    const result = spawnSync("bash", ["-c", gate], {
      env: { ...env, ...changes },
      encoding: "utf8",
    });
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.equal(await readFile(output, "utf8"), expectedOutput);
  }
});

test("GHCR publication is gated by successful main verification with bounded permissions", async () => {
  const ci = parse(await read(".github/workflows/ci.yml"));
  const publish = parse(await read(".github/workflows/publish-images.yml"));
  assert.ok(ci.on.push.branches.includes("main"));
  assert.equal(ci.jobs.publish.needs, "verify");
  assert.equal(
    ci.jobs.publish.if,
    "github.event_name == 'push' && github.ref == 'refs/heads/main'",
  );
  assert.equal(ci.jobs.publish.uses, "./.github/workflows/publish-images.yml");
  assert.deepEqual(ci.jobs.publish.permissions, {
    contents: "read",
    packages: "write",
  });
  assert.ok(Object.hasOwn(publish.on, "workflow_call"));
  assert.equal(
    publish.on.push,
    undefined,
    "Publishing cannot bypass the caller's verification job",
  );
  assert.equal(publish.concurrency["cancel-in-progress"], false);
  const gate = publish.jobs.release.steps.find((step) => step.id === "release");
  assert.match(gate.run, /refs\/heads\/main/);
  assert.match(gate.run, /current_sha.*!=.*GITHUB_SHA/);
  assert.equal(
    publish.jobs.publish.if,
    "needs.release.outputs.publish == 'true'",
  );
  for (const step of publish.jobs.publish.steps.filter((step) => step.uses)) {
    assert.match(
      step.uses,
      /@[a-f0-9]{40}$/,
      "Publishing actions must use verified immutable revisions",
    );
  }
  const login = publish.jobs.publish.steps.find((step) =>
    step.uses?.startsWith("docker/login-action@"),
  );
  assert.equal(login.with.registry, "ghcr.io");
  assert.equal(login.with.password, "${{ secrets.GITHUB_TOKEN }}");
});

test("published targets cover every owned production image and include the production gateway", async () => {
  const publish = parse(await read(".github/workflows/publish-images.yml"));
  const compose = parse(await read("deploy/production/compose.yaml"));
  const job = publish.jobs.publish;
  const matrix = job.strategy.matrix.include;
  assert.deepEqual(matrix.map((entry) => entry.name).sort(), [
    "account",
    "admin",
    "gateway",
    "provider",
    "tooling",
  ]);
  for (const entry of matrix) {
    const dockerfile = await read(entry.dockerfile);
    const stages = [...dockerfile.matchAll(/^FROM .+ AS (\S+)$/gim)].map(
      (match) => match[1],
    );
    assert.ok(
      stages.includes(entry.target),
      `${entry.name} publishes an existing Dockerfile target`,
    );
  }
  for (const service of Object.values(compose.services)) {
    assert.equal(
      service.build,
      undefined,
      "Production must run without a source build",
    );
    if (!service.image.includes("IDENTITY_IMAGE_PREFIX")) continue;
    assert.ok(
      matrix.some((entry) => service.image.includes(`}-${entry.name}:`)),
      service.image,
    );
    assert.ok(
      service.image.endsWith("${IDENTITY_VERSION:-main}"),
      "All artifacts share the selected release tag",
    );
  }
  const metadata = job.steps.find((step) => step.id === "meta");
  assert.match(metadata.with.tags, /value=main/);
  assert.match(metadata.with.tags, /value=sha-\$\{\{ github.sha \}\}/);
  const build = job.steps.find((step) =>
    step.uses?.startsWith("docker/build-push-action@"),
  );
  assert.equal(build.with.platforms, "linux/amd64,linux/arm64");
  assert.equal(build.with.push, true);
  assert.equal(
    build.with.secrets,
    undefined,
    "Production runtime secrets never enter the image build",
  );
  const runtime = await read("deploy/Runtime.Dockerfile");
  assert.match(
    runtime,
    /FROM web AS production-web\nCOPY deploy\/production\/nginx.conf \/etc\/nginx\/conf.d\/default.conf/,
  );
  assert.ok(
    !compose.services.gateway.volumes.some((volume) =>
      volume.includes("nginx.conf"),
    ),
    "The gateway uses configuration from its own published image",
  );
});
