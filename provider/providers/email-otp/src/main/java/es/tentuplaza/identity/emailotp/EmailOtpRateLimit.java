package es.tentuplaza.identity.emailotp;

import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import javax.crypto.Mac;
import org.keycloak.authentication.AuthenticationFlowContext;

/** Single-use cache reservations are shared by every replica and every send entry point. */
final class EmailOtpRateLimit {
  static String recipientKey(AuthenticationFlowContext context, String email) {
    try {
      var mac = Mac.getInstance("HmacSHA256");
      mac.init(context.getSession().keys().getActiveHmacKey(context.getRealm()).getSecretKey());
      return context.getRealm().getId() + ":" + HexFormat.of().formatHex(mac.doFinal(email.toLowerCase(java.util.Locale.ROOT).getBytes(StandardCharsets.UTF_8)));
    } catch (java.security.GeneralSecurityException error) { throw new IllegalStateException("OTP rate limiter unavailable", error); }
  }
  static boolean reserve(AuthenticationFlowContext context, String recipient) {
    var objects = context.getSession().singleUseObjects();
    if (!objects.putIfAbsent("tentu-otp-send:" + recipient, cooldown(context))) return false;
    // The transport address comes from Keycloak's trusted proxy configuration, not an arbitrary request header.
    String address = context.getConnection().getRemoteAddr();
    String origin = recipientKey(context, "origin:" + (address == null ? "unknown" : address));
    return slots(context, "tentu-otp-origin:" + origin, setting(context, "origin_max_per_ten_minutes", 30, 1000), 600)
        && slots(context, "tentu-otp-window:" + recipient, setting(context, "recipient_max_per_hour", 10, 100), 3600);
  }
  static int cooldown(AuthenticationFlowContext context) { return setting(context, "cooldown_seconds", 60, 600); }
  private static int setting(AuthenticationFlowContext context, String name, int fallback, int max) {
    try {
      int value = Integer.parseInt(context.getRealm().getAttribute("tentu.email_otp." + name));
      return value >= 1 && value <= max ? value : fallback;
    } catch (NumberFormatException error) { return fallback; }
  }
  private static boolean slots(AuthenticationFlowContext context, String key, int count, int ttl) {
    for (int slot = 0; slot < count; slot++)
      if (context.getSession().singleUseObjects().putIfAbsent(key + ":" + slot, ttl)) return true;
    return false;
  }
}
