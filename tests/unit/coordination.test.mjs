import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { acquireAuthorizationLock } from "../../packages/identity-internal/dist/coordination.js";

const linuxOnly = { skip: process.platform !== "linux", timeout: 10_000 };

async function lockFixture(t) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "score-authorization-lock-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "authorization.lock");
}

function waitForAcquisition(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("Child did not acquire its authorization lock.")),
      5_000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (!output.includes("acquired\n"))
        reject(
          new Error(
            `Lock child exited before acquisition (${code ?? signal}).`,
          ),
        );
    });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("acquired\n")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

test(
  "authorization coordination remains exclusive until release and tolerates double release",
  linuxOnly,
  async (t) => {
    const file = await lockFixture(t);
    const releaseFirst = await acquireAuthorizationLock(file);
    t.after(releaseFirst);
    let secondAcquired = false;
    let releaseSecond;
    t.after(() => releaseSecond?.());
    const second = acquireAuthorizationLock(file).then((release) => {
      releaseSecond = release;
      secondAcquired = true;
      return release;
    });
    await delay(150);
    assert.equal(
      secondAcquired,
      false,
      "A second holder must not enter while the first is active.",
    );
    releaseFirst();
    releaseFirst();
    await second;
    assert.equal(secondAcquired, true);
    releaseSecond();
    releaseSecond();
    const releaseThird = await acquireAuthorizationLock(file);
    releaseThird();
  },
);

test(
  "a crashed parent releases its kernel authorization lock for the next process",
  linuxOnly,
  async (t) => {
    const file = await lockFixture(t);
    const moduleUrl = new URL(
      "../../packages/identity-internal/dist/coordination.js",
      import.meta.url,
    );
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
    import { acquireAuthorizationLock } from ${JSON.stringify(moduleUrl.href)};
    await acquireAuthorizationLock(${JSON.stringify(file)});
    process.stdout.write('acquired\\n');
    setInterval(() => {}, 1000);
  `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    });
    await waitForAcquisition(child);
    const exited = once(child, "exit");
    assert.equal(child.kill("SIGKILL"), true);
    const [, signal] = await exited;
    assert.equal(signal, "SIGKILL");
    const release = await acquireAuthorizationLock(file);
    t.after(release);
    release();
  },
);

test(
  "lock-file acquisition failure rejects without poisoning a later valid lock",
  linuxOnly,
  async (t) => {
    const file = await lockFixture(t);
    await assert.rejects(
      acquireAuthorizationLock(
        path.join(
          path.dirname(file),
          "missing-directory",
          "authorization.lock",
        ),
      ),
      /coordination is unavailable/,
    );
    const release = await acquireAuthorizationLock(file);
    t.after(release);
    release();
  },
);

test(
  "explicit no-file fixture mode has an idempotent release",
  linuxOnly,
  async () => {
    const release = await acquireAuthorizationLock();
    release();
    release();
  },
);
