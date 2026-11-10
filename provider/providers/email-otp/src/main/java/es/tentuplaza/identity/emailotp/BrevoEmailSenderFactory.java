package es.tentuplaza.identity.emailotp;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import org.keycloak.Config;
import org.keycloak.email.EmailSenderProvider;
import org.keycloak.email.EmailSenderProviderFactory;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;

public final class BrevoEmailSenderFactory implements EmailSenderProviderFactory {
  private static final URI ENDPOINT = URI.create("https://api.brevo.com/v3/smtp/email");
  private HttpClient client;
  private BrevoEmailSender sender;

  @Override
  public void init(Config.Scope config) {
    String file = System.getenv("BREVO_API_KEY_FILE");
    if (file == null || file.isBlank()) return;
    String key;
    try {
      key = Files.readString(Path.of(file)).strip();
    } catch (IOException e) {
      throw new IllegalStateException("Unable to read BREVO_API_KEY_FILE.");
    }
    if (key.isEmpty() || !key.chars().allMatch(c -> c > 32 && c < 127)) {
      throw new IllegalStateException("BREVO_API_KEY_FILE must contain a Brevo API key.");
    }
    client = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .followRedirects(HttpClient.Redirect.NEVER)
        .build();
    sender = new BrevoEmailSender(client, ENDPOINT, key);
  }

  @Override
  public EmailSenderProvider create(KeycloakSession session) {
    return sender != null ? sender : session.getProvider(EmailSenderProvider.class, "default");
  }

  @Override
  public String getId() {
    return "score-brevo";
  }

  @Override
  public void postInit(KeycloakSessionFactory factory) {}

  @Override
  public void close() {
    if (client != null) client.close();
  }
}
