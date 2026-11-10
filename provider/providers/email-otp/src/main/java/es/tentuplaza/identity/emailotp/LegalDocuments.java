package es.tentuplaza.identity.emailotp;

import java.net.URI;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;

/** Published editorial references are configuration, never legal text stored in Keycloak. */
final class LegalDocuments {
  private LegalDocuments() { }
  static String value(RealmModel realm, String kind, String field) {
    boolean configuredReference = java.util.stream.Stream.of("url", "version", "digest")
        .anyMatch(key -> realm.getAttribute("tentu.legal." + kind + "." + key) != null
            && !realm.getAttribute("tentu.legal." + kind + "." + key).isBlank());
    if (configuredReference && java.util.stream.Stream.of("url", "version", "digest")
        .anyMatch(key -> realm.getAttribute("tentu.legal." + kind + "." + key) == null
            || realm.getAttribute("tentu.legal." + kind + "." + key).isBlank()))
      throw new jakarta.ws.rs.ServiceUnavailableException("Incomplete published legal reference");
    String configured = realm.getAttribute("tentu.legal." + kind + "." + field);
    if (configured != null && !configured.isBlank()) {
      boolean valid = switch (field) {
        case "url" -> validUrl(configured);
        case "version" -> configured.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,79}");
        case "digest" -> configured.matches("sha256:[a-f0-9]{64}");
        default -> false;
      };
      if (!valid) throw new jakarta.ws.rs.ServiceUnavailableException("Invalid published legal reference");
      return configured;
    }
    // Historical registration remains labelled as legacy; no digest is invented.
    return "url".equals(field) ? "https://score.us.es" : "version".equals(field) ? "2026-09" : "";
  }
  static boolean validUrl(String value) {
    try {
      var url = URI.create(value);
      return url.getHost() != null && url.getUserInfo() == null && url.getFragment() == null
          && ("https".equals(url.getScheme()) || ("http".equals(url.getScheme()) && "localhost".equals(url.getHost())));
    } catch (IllegalArgumentException error) { return false; }
  }
  static void present(AuthenticationFlowContext context) {
    for (String kind : new String[]{"terms", "privacy"}) {
      for (String field : new String[]{"url", "version", "digest"}) {
        String note = "tentu.registration.legal." + kind + "." + field;
        String reference = context.getAuthenticationSession().getAuthNote(note);
        if (reference == null) {
          reference = value(context.getRealm(), kind, field);
          context.getAuthenticationSession().setAuthNote(note, reference);
        }
        if ("url".equals(field)) context.form().setAttribute(kind + "DocumentUrl", reference);
      }
    }
  }
  static void record(AuthenticationFlowContext context, UserModel user) {
    for (String kind : new String[]{"terms", "privacy"}) {
      String prefix = "tentu" + Character.toUpperCase(kind.charAt(0)) + kind.substring(1);
      String version = context.getAuthenticationSession().getAuthNote("tentu.registration.legal." + kind + ".version");
      String digest = context.getAuthenticationSession().getAuthNote("tentu.registration.legal." + kind + ".digest");
      // Registration must have presented references in this authentication session.
      if (version == null) throw new jakarta.ws.rs.BadRequestException("Legal documents were not presented");
      user.setSingleAttribute(prefix + "Version", version);
      if (digest != null && !digest.isBlank()) user.setSingleAttribute(prefix + "Digest", digest);
      else user.removeAttribute(prefix + "Digest");
    }
  }
}
