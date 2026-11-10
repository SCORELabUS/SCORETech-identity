import { readFile, appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionParts = (value) => {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(
    value || "",
  );
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const stable = (releases) =>
  releases.filter(
    (release) =>
      !release.draft && !release.prerelease && versionParts(release.tag_name),
  );

export function nextReleaseVersion(base, releases) {
  const minimum = versionParts(base);
  if (!minimum)
    throw new Error("The package version must be a stable semantic version.");
  const previous = stable(releases)
    .map((release) => versionParts(release.tag_name))
    .sort(compare)
    .at(-1);
  if (!previous || compare(minimum, previous) > 0) return minimum.join(".");
  if (previous[2] === Number.MAX_SAFE_INTEGER)
    throw new Error("Release patch version is exhausted.");
  return [previous[0], previous[1], previous[2] + 1].join(".");
}

export function releaseNotes({
  repository,
  sha,
  version,
  commits,
  previousTag,
}) {
  const prefix = `ghcr.io/${repository.toLowerCase()}`;
  const lines = commits
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [commit, ...subject] = line.split("\0");
      if (!/^[a-f0-9]{40}$/.test(commit))
        throw new Error("Invalid changelog commit identifier.");
      const title = subject
        .join(" ")
        .replace(/[\r\n]/g, " ")
        .replace(/[\\`*_[\]<>]/g, "\\$&");
      return `- ${title} ([${commit.slice(0, 8)}](https://github.com/${repository}/commit/${commit}))`;
    });
  return [
    `SCORETech Identity v${version}`,
    "",
    `Verified main revision: [${sha.slice(0, 8)}](https://github.com/${repository}/commit/${sha}).`,
    "",
    "## Changelog",
    "",
    ...(lines.length
      ? lines
      : ["- Release verification and packaging update."]),
    "",
    "## Published images",
    "",
    ...["provider", "account", "admin", "gateway", "tooling"].map(
      (name) =>
        `- \`${prefix}-${name}:sha-${sha}\` (also published as \`main\`)`,
    ),
    "",
    "## Update the server",
    "",
    "Keep the repository on the main branch and retain the private environment, runtime and persistent volumes.",
    "Run after the release and all image jobs have completed:",
    "",
    "```bash",
    "git pull --ff-only origin main",
    "docker compose -f docker/production/compose.yaml pull",
    "docker compose -f docker/production/compose.yaml up -d --no-build --wait --wait-timeout 300",
    "```",
    "",
    "The production environment uses `IDENTITY_VERSION=main`. No detached checkout or routine version edit is required.",
    "",
    previousTag
      ? `[Full changelog](https://github.com/${repository}/compare/${previousTag}...v${version})`
      : "Initial release.",
    "",
  ].join("\n");
}

/** Create a source-bound release only after the caller has published all images. */
export async function publishRelease({
  env = process.env,
  fetchImpl = globalThis.fetch,
  runGit,
} = {}) {
  if (env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF !== "refs/heads/main")
    throw new Error("Releases require a verified push to main.");
  const repository = env.GITHUB_REPOSITORY;
  const sha = env.GITHUB_SHA;
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "") ||
    !/^[a-f0-9]{40}$/.test(sha || "") ||
    !token
  )
    throw new Error(
      "Release repository, source SHA and GitHub token are required.",
    );
  const request = async (suffix, body) => {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/${suffix}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok)
      throw new Error(`GitHub release request failed (${response.status}).`);
    return response.json();
  };
  const releases = [];
  for (let page = 1; ; page++) {
    const entries = await request(`releases?per_page=100&page=${page}`);
    if (!Array.isArray(entries))
      throw new Error("Invalid GitHub releases response.");
    releases.push(...entries);
    if (entries.length < 100) break;
  }
  const existing = stable(releases).find(
    (release) => release.target_commitish === sha,
  );
  if (existing)
    return { tag: existing.tag_name, url: existing.html_url, reused: true };
  const { version: base } = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const version = nextReleaseVersion(base, releases);
  const previous = stable(releases)
    .sort((a, b) => compare(versionParts(a.tag_name), versionParts(b.tag_name)))
    .at(-1);
  const git =
    runGit ||
    ((args) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      }));
  const commits = git([
    "log",
    "--no-merges",
    "--reverse",
    "--format=%H%x00%s",
    previous ? `${previous.tag_name}..${sha}` : sha,
    "--",
  ]);
  const created = await request("releases", {
    tag_name: `v${version}`,
    target_commitish: sha,
    name: `SCORETech Identity v${version}`,
    body: releaseNotes({
      repository,
      sha,
      version,
      commits,
      previousTag: previous?.tag_name,
    }),
    draft: false,
    prerelease: false,
    make_latest: "true",
  });
  if (
    created.tag_name !== `v${version}` ||
    created.target_commitish !== sha ||
    typeof created.html_url !== "string"
  )
    throw new Error("The created release response could not be verified.");
  return { tag: created.tag_name, url: created.html_url, reused: false };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const release = await publishRelease();
  console.log(`SCORETech Identity release: ${release.url}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `\n### Release\n\n[${release.tag}](${release.url})\n`,
    );
}
