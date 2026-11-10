import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nextReleaseVersion,
  releaseNotes,
  publishRelease,
} from "../../tooling/publish-release.mjs";

const sha = "a".repeat(40);
const repository = "SCORELabUS/SCORETech-identity";
const env = {
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: repository,
  GITHUB_SHA: sha,
  GH_TOKEN: "fixture-release-token",
};
const release = (tag, extra = {}) => ({
  tag_name: tag,
  target_commitish: "c".repeat(40),
  draft: false,
  prerelease: false,
  ...extra,
});

test("release versions start at the package base and advance stable patches", () => {
  assert.equal(nextReleaseVersion("0.1.0", []), "0.1.0");
  assert.equal(
    nextReleaseVersion("0.1.0", [release("v0.1.3"), release("v0.1.1")]),
    "0.1.4",
  );
  assert.equal(nextReleaseVersion("0.2.0", [release("v0.1.3")]), "0.2.0");
  assert.equal(
    nextReleaseVersion("0.1.0", [
      release("v9.0.0", { draft: true }),
      release("v8.0.0", { prerelease: true }),
      release("not-a-version"),
    ]),
    "0.1.0",
  );
  assert.throws(() => nextReleaseVersion("invalid", []));
});

test("release notes include commits, all artifacts and main-based update commands", () => {
  const notes = releaseNotes({
    repository,
    sha,
    version: "0.1.1",
    previousTag: "v0.1.0",
    commits: `${"b".repeat(40)}\0fix(auth): keep SSO stable\n`,
  });
  assert.match(notes, /fix\(auth\): keep SSO stable/);
  assert.match(notes, /git pull --ff-only origin main/);
  assert.match(notes, /IDENTITY_VERSION=main/);
  assert.ok(!notes.includes("checkout --detach"));
  for (const image of ["provider", "account", "admin", "gateway", "tooling"])
    assert.ok(
      notes.includes(
        `ghcr.io/scorelabus/scoretech-identity-${image}:sha-${sha}`,
      ),
    );
  assert.ok(notes.includes("compare/v0.1.0...v0.1.1"));
});

test("release creation uses paginated history, exact source SHA and incremental commits", async () => {
  const calls = [];
  let argumentsUsed;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, "Bearer fixture-release-token");
    if (options.method === "GET")
      return new Response(
        JSON.stringify(
          url.endsWith("page=1")
            ? Array.from({ length: 100 }, (_, i) => release(`legacy-${i}`))
            : [release("v0.1.2")],
        ),
      );
    const body = JSON.parse(options.body);
    assert.equal(body.tag_name, "v0.1.3");
    assert.equal(body.target_commitish, sha);
    assert.equal(body.draft, false);
    assert.equal(body.prerelease, false);
    assert.ok(body.body.includes("fix: release fixture"));
    return new Response(
      JSON.stringify({
        ...body,
        html_url: "https://github.com/example/release",
      }),
      { status: 201 },
    );
  };
  const result = await publishRelease({
    env,
    fetchImpl,
    runGit: (args) => {
      argumentsUsed = args;
      return `${"d".repeat(40)}\0fix: release fixture\n`;
    },
  });
  assert.equal(result.tag, "v0.1.3");
  assert.equal(result.reused, false);
  assert.ok(argumentsUsed.includes(`v0.1.2..${sha}`));
  assert.equal(calls.length, 3);
});

test("a retry reuses the existing source-bound release without moving tags", async () => {
  let calls = 0;
  const result = await publishRelease({
    env,
    fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(options.method, "GET");
      return new Response(
        JSON.stringify([
          release("v0.1.0", {
            target_commitish: sha,
            html_url: "https://github.com/example/existing",
          }),
        ]),
      );
    },
    runGit: () => {
      throw new Error("Existing releases do not regenerate history");
    },
  });
  assert.equal(result.reused, true);
  assert.equal(calls, 1);
});

test("release publication rejects other events and does not expose API error bodies", async () => {
  const unavailable = async () => {
    throw new Error("Unexpected network access");
  };
  await assert.rejects(
    publishRelease({
      env: { ...env, GITHUB_REF: "refs/heads/develop" },
      fetchImpl: unavailable,
    }),
    /verified push to main/,
  );
  await assert.rejects(
    publishRelease({
      env: { ...env, GITHUB_EVENT_NAME: "pull_request" },
      fetchImpl: unavailable,
    }),
    /verified push to main/,
  );
  await assert.rejects(
    publishRelease({
      env,
      fetchImpl: async () =>
        new Response("private response details", { status: 403 }),
    }),
    (error) =>
      error.message.includes("403") &&
      !error.message.includes("private response"),
  );
});
