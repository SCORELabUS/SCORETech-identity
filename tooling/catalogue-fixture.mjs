// Local laboratory only. Implements the GitHub protocol used by the real adapter.
// No port is published to the host; never enable this service in production.
import http from "node:http";
import { readFile, writeFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
const statePath =
  (process.env.IDENTITY_RUNTIME_DIR || "/runtime") + "/github/state.json";
let state = JSON.parse(await readFile(statePath, "utf8"));
const hash = (v) => createHash("sha1").update(JSON.stringify(v)).digest("hex");
let writes = Promise.resolve();
const save = () => {
  writes = writes.then(async () => {
    const tmp = statePath + ".tmp";
    await writeFile(tmp, JSON.stringify(state));
    await rename(tmp, statePath);
  });
  return writes;
};
const send = (res, status, value) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
};
http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://fixture");
      if (url.pathname === "/health") {
        send(res, 200, { status: "UP" });
        return;
      }
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
        if (chunks.reduce((n, b) => n + b.length, 0) > 6_000_000)
          throw new Error("Payload too large");
      }
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : {};
      if (
        req.method === "POST" &&
        /^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)
      ) {
        send(res, 201, {
          token: "fixture-local-token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
        return;
      }
      if (req.headers.authorization !== "Bearer fixture-local-token") {
        send(res, 401, { message: "Fixture token required" });
        return;
      }
      const match = /^\/repos\/SCORELabUS\/SCORETech-identity(\/.*)$/.exec(
        url.pathname,
      );
      if (!match) {
        send(res, 404, { message: "Unknown fixture repository" });
        return;
      }
      const p = match[1];
      if (req.method === "GET" && p.startsWith("/git/ref/heads/")) {
        send(res, 200, { object: { sha: state.head } });
        return;
      }
      if (req.method === "GET" && p.startsWith("/contents/")) {
        const commit = state.commits[url.searchParams.get("ref") || state.head];
        const files = commit ? state.trees[commit.tree] : null;
        const key = decodeURIComponent(p.slice("/contents/".length));
        if (!files) {
          send(res, 404, { message: "Revision not found" });
          return;
        }
        if (files[key] !== undefined) {
          send(res, 200, {
            encoding: "base64",
            content: Buffer.from(files[key]).toString("base64"),
            size: Buffer.byteLength(files[key]),
          });
          return;
        }
        const keys = Object.keys(files).filter((k) => k.startsWith(key + "/"));
        if (keys.length) {
          send(
            res,
            200,
            keys.map((k) => ({
              name: k.slice(key.length + 1),
              path: k,
              type: "file",
            })),
          );
          return;
        }
        send(res, 404, { message: "File not found" });
        return;
      }
      if (req.method === "GET" && p.startsWith("/git/commits/")) {
        const commit = state.commits[p.slice("/git/commits/".length)];
        if (!commit) {
          send(res, 404, {});
          return;
        }
        send(res, 200, {
          tree: { sha: commit.tree },
          parents: commit.parents.map((sha) => ({ sha })),
        });
        return;
      }
      if (req.method === "POST" && p === "/git/trees") {
        const base = state.trees[body.base_tree];
        if (!base) {
          send(res, 422, {});
          return;
        }
        const files = { ...base };
        for (const entry of body.tree) {
          if (
            typeof entry.path !== "string" ||
            typeof entry.content !== "string" ||
            entry.path.includes("..")
          ) {
            send(res, 422, {});
            return;
          }
          files[entry.path] = entry.content;
        }
        const sha = hash(files);
        state.trees[sha] = files;
        await save();
        send(res, 201, { sha });
        return;
      }
      if (req.method === "POST" && p === "/git/commits") {
        if (
          !state.trees[body.tree] ||
          body.parents?.length !== 1 ||
          !state.commits[body.parents[0]]
        ) {
          send(res, 422, {});
          return;
        }
        const sha = hash({ ...body, nonce: randomUUID() });
        state.commits[sha] = { tree: body.tree, parents: body.parents };
        await save();
        send(res, 201, { sha });
        return;
      }
      if (req.method === "PATCH" && p.startsWith("/git/refs/heads/")) {
        const commit = state.commits[body.sha];
        if (
          !commit ||
          body.force !== false ||
          commit.parents[0] !== state.head
        ) {
          send(res, 422, { message: "Non-fast-forward" });
          return;
        }
        state.head = body.sha;
        await save();
        send(res, 200, { object: { sha: state.head } });
        return;
      }
      send(res, 404, { message: "Unsupported fixture endpoint" });
    } catch (error) {
      console.error("Fixture request failed:", error.message);
      send(res, 400, { message: "Invalid fixture request" });
    }
  })
  .listen(8090, "0.0.0.0", () =>
    console.log("Local catalogue protocol fixture ready."),
  );
