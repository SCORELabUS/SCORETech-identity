package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import org.junit.jupiter.api.Test;

class EmailOtpRateLimitTest {
  @Test void recipientBudgetCannotBeBypassedByWaitingOnlyForCooldown() throws Exception {
    var f = new EmailOtpAuthenticatorTest.Fixture();
    String key = EmailOtpRateLimit.recipientKey(f.context, "person@example.invalid");
    for (int i = 0; i < 10; i++) { f.cache.remove("tentu-otp-send:" + key); assertTrue(EmailOtpRateLimit.reserve(f.context, key)); }
    f.cache.remove("tentu-otp-send:" + key); assertFalse(EmailOtpRateLimit.reserve(f.context, key));
  }
  @Test void originBudgetBoundsAttemptsAcrossDifferentRecipients() throws Exception {
    var f = new EmailOtpAuthenticatorTest.Fixture();
    for (int i = 0; i < 30; i++) assertTrue(EmailOtpRateLimit.reserve(f.context, EmailOtpRateLimit.recipientKey(f.context, i + "@example.invalid")));
    assertFalse(EmailOtpRateLimit.reserve(f.context, EmailOtpRateLimit.recipientKey(f.context, "overflow@example.invalid")));
  }
  @Test void serverConfigurationIsBoundedAndKeysDoNotExposeRecipients() throws Exception {
    var f = new EmailOtpAuthenticatorTest.Fixture();
    var key = EmailOtpRateLimit.recipientKey(f.context, "Person@example.invalid");
    assertEquals(key, EmailOtpRateLimit.recipientKey(f.context, "person@example.invalid")); assertFalse(key.contains("example.invalid"));
    when(f.context.getRealm().getAttribute("tentu.email_otp.cooldown_seconds")).thenReturn("90");assertEquals(90, EmailOtpRateLimit.cooldown(f.context));
    when(f.context.getRealm().getAttribute("tentu.email_otp.cooldown_seconds")).thenReturn("0");assertEquals(60, EmailOtpRateLimit.cooldown(f.context));
  }
}
