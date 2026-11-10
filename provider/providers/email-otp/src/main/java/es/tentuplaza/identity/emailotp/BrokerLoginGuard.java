package es.tentuplaza.identity.emailotp;

import java.time.Instant;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.Authenticator;
import org.keycloak.models.*;
import jakarta.ws.rs.core.Response;

/** The broker proves external identity, never local administrative authority. */
public final class BrokerLoginGuard implements Authenticator {
  static final String AUTHENTICATED_USER = "score.broker.authenticated-user";
  static final String NEW_USER = "BROKER_REGISTERED_NEW_USER";
  static final String PHASE = "score.broker.guard.phase";
  static final String CONSENT = "consent";
  static final String PASSKEY = "passkey";
  static final String PENDING = "scoreBrokerOnboardingPending";

  @Override public void authenticate(AuthenticationFlowContext context) {
    var user = context.getUser();
    if (user == null || !user.isEnabled()) { deny(context); return; }
    if (blank(user.getEmail())) { deny(context); return; }
    if ("true".equals(context.getAuthenticationSession().getAuthNote(NEW_USER))) {
      user.setSingleAttribute(PENDING, "true");
      user.setSingleAttribute(InvitationStore.PROVISIONAL, "true");
    }
    if (blank(user.getFirstAttribute("tentuTermsVersion")) || blank(user.getFirstAttribute("tentuPrivacyVersion"))) {
      consent(context, false); return;
    }
    complete(context);
  }

  @Override public void action(AuthenticationFlowContext context) {
    String phase = context.getAuthenticationSession().getAuthNote(PHASE);
    if (PASSKEY.equals(phase)) {
      // Native verification records the server-owned passkey attestation on success.
      EmailOtpAuthenticator.INSTANCE.action(context);
      return;
    }
    if (!CONSENT.equals(phase) || context.getUser() == null || !context.getUser().isEnabled()) {
      deny(context); return;
    }
    var form = context.getHttpRequest().getDecodedFormParameters();
    if (!"true".equals(form.getFirst("terms")) || !"true".equals(form.getFirst("privacy"))) {
      consent(context, true); return;
    }
    LegalDocuments.record(context, context.getUser());
    context.getUser().setSingleAttribute("tentuRegistrationCompletedAt", Instant.now().toString());
    complete(context);
  }

  private void consent(AuthenticationFlowContext context, boolean error) {
    context.getAuthenticationSession().setAuthNote(PHASE, CONSENT);
    LegalDocuments.present(context);
    var form = context.form();
    if (error) form.setError("emailOtpConsentRequired");
    context.challenge(form.createForm("broker-consent.ftl"));
  }

  private void complete(AuthenticationFlowContext context) {
    var user = context.getUser();
    if ("true".equals(context.getAuthenticationSession().getAuthNote(NEW_USER))
        || "true".equals(user.getFirstAttribute(PENDING))) {
      var role = RegistrationPolicy.defaultRole(context.getRealm());
      if (role != null) user.grantRole(role);
      user.removeAttribute(PENDING);
      user.removeAttribute(InvitationStore.PROVISIONAL);
      context.getAuthenticationSession().removeAuthNote(NEW_USER);
    }

    try {
      ClientAccessRules.enforce(context.getRealm(), user, context.getAuthenticationSession().getClient(),
          context.getAuthenticationSession().getRedirectUri());
    } catch (jakarta.ws.rs.ForbiddenException denied) { deny(context); return; }
    // A server-owned, user-bound note exempts this broker transaction from a
    // redundant mailbox challenge without asserting ownership of CAS email.
    context.getAuthenticationSession().setAuthNote(AUTHENTICATED_USER, user.getId());
    context.getAuthenticationSession().setUserSessionNote(AUTHENTICATED_USER, user.getId());
    if (AuthenticationPolicy.isAdmin(context.getRealm(), user)) {
      if (AuthenticationPolicy.hasPasskey(user)) {
        context.getAuthenticationSession().setAuthNote(PHASE, PASSKEY);
        EmailOtpAuthenticator.INSTANCE.beginVerification(context);
        return;
      }
      context.getAuthenticationSession().addRequiredAction(AuthenticationPolicy.REGISTER);
    }
    context.getAuthenticationSession().removeAuthNote(PHASE);
    AuthenticationPolicy.record(context.getAuthenticationSession(), context.getRealm(), user, "external");
    context.success();
  }

  private static boolean blank(String value) { return value == null || value.isBlank(); }
  private static void deny(AuthenticationFlowContext context) {
    context.failureChallenge(AuthenticationFlowError.ACCESS_DENIED,
        context.form().setError("Your account cannot access this application.").createErrorPage(Response.Status.FORBIDDEN));
  }
  @Override public boolean requiresUser() { return true; }
  @Override public boolean configuredFor(KeycloakSession session, RealmModel realm, UserModel user) { return true; }
  @Override public void setRequiredActions(KeycloakSession session, RealmModel realm, UserModel user) { }
  @Override public void close() { }
}
