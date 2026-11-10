// Loopback CAS fixture. Run in the Keycloak network namespace for broker E2E only.
import http from "node:http";
http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost:18899");
    if (
      url.pathname === "/serviceValidate" &&
      /^ST-fixture-\d+$/.test(url.searchParams.get("ticket") || "") &&
      (url.searchParams.get("service") || "").startsWith(
        "http://localhost:18000/api/v1/users/auth/sso/us/callback?state=sti.",
      )
    ) {
      const run = url.searchParams.get("ticket").slice("ST-fixture-".length);
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(
        `<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas"><cas:authenticationSuccess><cas:user>cas-fixture-${run}</cas:user><cas:attributes><cas:mail>cas-fixture-${run}@example.invalid</cas:mail><cas:givenname>CAS</cas:givenname><cas:sn>Fixture</cas:sn></cas:attributes></cas:authenticationSuccess></cas:serviceResponse>`,
      );
    } else {
      res.writeHead(400);
      res.end("Invalid fixture request");
    }
  })
  .listen(18899, "127.0.0.1");
