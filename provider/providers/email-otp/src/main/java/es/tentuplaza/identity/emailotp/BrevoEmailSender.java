package es.tentuplaza.identity.emailotp;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jboss.logging.Logger;
import org.keycloak.email.EmailException;
import org.keycloak.email.EmailSenderProvider;
import org.keycloak.util.JsonSerialization;
import org.keycloak.utils.EmailValidationUtil;

final class BrevoEmailSender implements EmailSenderProvider {
  private static final Logger LOG = Logger.getLogger(BrevoEmailSender.class);
  private final HttpClient client;
  private final URI endpoint;
  private final String apiKey;

  BrevoEmailSender(HttpClient client, URI endpoint, String apiKey) {
    this.client = client;
    this.endpoint = endpoint;
    this.apiKey = apiKey;
  }

  @Override
  public void send(Map<String, String> config, String address, String subject,
                   String textBody, String htmlBody) throws EmailException {
    validate(config);
    requireEmail(address, "recipient");
    Map<String, Object> message = new LinkedHashMap<>();
    message.put("sender", contact(config.get("from"), config.get("fromDisplayName")));
    message.put("to", List.of(contact(address, null)));
    message.put("subject", subject);
    if (textBody != null) message.put("textContent", textBody);
    if (htmlBody != null) message.put("htmlContent", htmlBody);
    if (hasValue(config.get("replyTo"))) {
      message.put("replyTo", contact(config.get("replyTo"), config.get("replyToDisplayName")));
    }

    try {
      HttpRequest request = HttpRequest.newBuilder(endpoint)
          .timeout(Duration.ofSeconds(10))
          .header("api-key", apiKey)
          .header("Content-Type", "application/json")
          .POST(HttpRequest.BodyPublishers.ofByteArray(JsonSerialization.writeValueAsBytes(message)))
          .build();
      int status = client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode();
      if (status != 201) {
        LOG.warnf("Brevo transactional email rejected: HTTP %d", status);
        throw new EmailException("Brevo rejected the transactional email (HTTP " + status + ").");
      }
    } catch (IOException e) {
      LOG.warnf("Brevo transactional email failed: %s", e.getClass().getSimpleName());
      throw new EmailException("Brevo request failed (" + e.getClass().getSimpleName() + ").");
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new EmailException("Brevo request was interrupted.");
    }
  }

  @Override
  public void validate(Map<String, String> config) throws EmailException {
    requireEmail(config.get("from"), "sender");
    if (hasValue(config.get("replyTo"))) requireEmail(config.get("replyTo"), "reply-to");
  }

  private static void requireEmail(String email, String field) throws EmailException {
    if (!hasValue(email) || !EmailValidationUtil.isValidEmail(email)) {
      throw new EmailException("Invalid Brevo " + field + " address.");
    }
  }

  private static boolean hasValue(String value) {
    return value != null && !value.isBlank();
  }

  private static Map<String, String> contact(String email, String name) {
    return hasValue(name) ? Map.of("email", email, "name", name) : Map.of("email", email);
  }

  @Override
  public void close() {}
}
