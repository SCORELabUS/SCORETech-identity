package es.tentuplaza.identity.emailotp;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.keycloak.email.EmailException;
import org.keycloak.util.JsonSerialization;
import static org.junit.jupiter.api.Assertions.*;

class BrevoEmailSenderTest {
  @Test
  void sendsTheRenderedEmailAndKeepsRejectedResponseDetailsPrivate() throws Exception {
    var request = new AtomicReference<String>();
    var apiKey = new AtomicReference<String>();
    var method = new AtomicReference<String>();
    var status = new AtomicInteger(201);
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext("/v3/smtp/email", exchange -> {
      try (exchange) {
        request.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
        apiKey.set(exchange.getRequestHeaders().getFirst("api-key"));
        method.set(exchange.getRequestMethod());
        byte[] response = "private upstream details".getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(status.get(), response.length);
        exchange.getResponseBody().write(response);
      }
    });
    server.start();
    try (var client = HttpClient.newHttpClient()) {
      var endpoint = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/v3/smtp/email");
      var sender = new BrevoEmailSender(client, endpoint, "test-api-key");
      var config = Map.of("from", "identity@example.org", "fromDisplayName", "SCORETech Identity");
      sender.send(config, "person@example.org", "Sign-in code", "Code: 123456", "<p>Code: 123456</p>");

      assertEquals("POST", method.get());
      assertEquals("test-api-key", apiKey.get());
      var body = JsonSerialization.mapper.readTree(request.get());
      assertEquals("identity@example.org", body.at("/sender/email").asText());
      assertEquals("SCORETech Identity", body.at("/sender/name").asText());
      assertEquals("person@example.org", body.at("/to/0/email").asText());
      assertEquals("Sign-in code", body.get("subject").asText());
      assertEquals("Code: 123456", body.get("textContent").asText());
      assertEquals("<p>Code: 123456</p>", body.get("htmlContent").asText());
      assertFalse(request.get().contains("test-api-key"));

      status.set(401);
      var error = assertThrows(EmailException.class,
          () -> sender.send(config, "person@example.org", "Sign-in code", "Code: 123456", null));
      assertEquals("Brevo rejected the transactional email (HTTP 401).", error.getMessage());
    } finally {
      server.stop(0);
    }
  }
}
