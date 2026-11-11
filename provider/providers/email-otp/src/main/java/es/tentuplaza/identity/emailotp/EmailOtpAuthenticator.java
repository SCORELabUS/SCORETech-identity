package es.tentuplaza.identity.emailotp;

import jakarta.ws.rs.core.MultivaluedMap;
import jakarta.ws.rs.core.Response;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.Authenticator;
import org.keycloak.email.EmailTemplateProvider;
import org.keycloak.forms.login.LoginFormsProvider;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.jboss.logging.Logger;

/** Passwordless email OTP. Codes are only hashed in the authentication session. */
public final class EmailOtpAuthenticator implements Authenticator {
  static final EmailOtpAuthenticator INSTANCE = new EmailOtpAuthenticator();
  private static final Logger LOG = Logger.getLogger(EmailOtpAuthenticator.class);
  private static final SecureRandom RANDOM = new SecureRandom();
  private static final long LIFESPAN_SECONDS = 600;
  private static final int MAX_ATTEMPTS = 5;
  private static final String CODE_HASH = "tentu.email_otp.hash";
  private static final String EXPIRES_AT = "tentu.email_otp.expires_at";
  private static final String METHOD = "tentu.selected_method";
  private static final String ATTEMPTS = "tentu.email_otp.attempts";

  @Override public void authenticate(AuthenticationFlowContext context) {
    RegistrationNotice.capture(context);
    recordDevice(context);
    if (InvitationRegistration.bind(context)) return;
    if (context.getAuthenticationSession().getAuthNote(InvitationStore.NOTE) != null) { challengeDetails(context,null); return; }
    if (StepUpResourceFactory.bind(context)) return;
    if (!normalLogin(context) && context.getRealm().isRememberMe()) {
      var existing = org.keycloak.services.managers.AuthenticationManager.authenticateIdentityCookie(context.getSession(), context.getRealm(), true);
      if (existing != null && existing.session().isRememberMe())
        context.getAuthenticationSession().setAuthNote("tentu.remember.previous_user", existing.user().getId());
    }
    final org.keycloak.models.UserSessionModel[] previous = {null};
    // Native cookie validation honours prompt=login, max_age and SSO expiry.
    try { new org.keycloak.authentication.authenticators.browser.CookieAuthenticator().authenticate(
        AuthenticationPolicy.observe(AuthenticationFlowContext.class, context, (name, args) -> {
          if (name.equals("attachUserSession")) previous[0] = (org.keycloak.models.UserSessionModel) args[0];
          if (name.equals("success")) {
            enforceClientAccess(context);
            var existing = previous[0];
            AuthenticationPolicy.inheritBrokerAuthentication(context.getAuthenticationSession(), existing, context.getUser());
            if (AuthenticationPolicy.isAdmin(context.getRealm(), context.getUser()) &&
                (existing == null || !"true".equals(existing.getNote(AuthenticationPolicy.ADMIN)) || !AuthenticationPolicy.hasPasskey(context.getUser())))
              throw new SsoStepUp();
          }
        })); } catch (SsoStepUp ignored) {
      if (AuthenticationPolicy.hasPasskey(context.getUser())) startMethod(context, "passkey");
      else challengeMethods(context, null);
      return;
    } catch(ClientDenied denied) { return; }
    if (context.getStatus() != org.keycloak.authentication.FlowStatus.SUCCESS) challengeDetails(context, null);
  }
  private static final class SsoStepUp extends RuntimeException { }
  private static final class ClientDenied extends RuntimeException { }
  private void enforceClientAccess(AuthenticationFlowContext context) {
    try {
      ClientAccessRules.enforce(context.getRealm(),context.getUser(),context.getAuthenticationSession().getClient(),context.getAuthenticationSession().getRedirectUri());
    } catch(jakarta.ws.rs.ForbiddenException denied) {
      context.failureChallenge(org.keycloak.authentication.AuthenticationFlowError.ACCESS_DENIED,
        context.form().setError("Your current permissions do not allow access to this application.").createErrorPage(Response.Status.FORBIDDEN));
      throw new ClientDenied();
    }
  }


  @Override public void action(AuthenticationFlowContext context) {
    try { actionInternal(context); } catch(ClientDenied denied) { /* Explicit forbidden challenge already supplied. */ }
  }
  private void actionInternal(AuthenticationFlowContext context) {
    context=StepUpResourceFactory.frame(context);
    recordDevice(context);
    MultivaluedMap<String, String> form = context.getHttpRequest().getDecodedFormParameters();
    String stage = form.getFirst("stage");
    if ("methods".equals(stage)) { context.getAuthenticationSession().removeAuthNote(METHOD); challengeMethods(context, null, form.getFirst("currentMethod")); return; }
    if ("select".equals(stage)) { startMethod(context, form.getFirst("method")); return; }
    String method = context.getAuthenticationSession().getAuthNote(METHOD);
    signInChallengeForm(context).setAttribute("allowOtherMethods", hasOtherMethod(context.getRealm(), context.getUser(), method))
        .setAttribute("selectedMethod", method);
    if ("passkey".equals(method) && !"resend".equals(stage)) {
      new org.keycloak.authentication.authenticators.browser.WebAuthnPasswordlessAuthenticator(context.getSession()).action(verifiedContext(context, AuthenticationPolicy.PASSKEY)); return;
    }
    if ("totp".equals(method)) {
      new org.keycloak.authentication.authenticators.browser.OTPFormAuthenticator().action(verifiedContext(context, "otp")); return;
    }
    if ("verify".equals(stage) && identifier(context) != null) { verify(context, form.getFirst("code")); return; }
    if ("resend".equals(stage) && identifier(context) != null) { sendCode(context, context.getUser(), identifier(context), true); return; }
    if ("register".equals(stage)) { register(context, form); return; }
    if(context.getAuthenticationSession().getAuthNote(StepUpResourceFactory.NOTE)!=null) { challengeMethods(context,null); return; }
    identify(context, form);
  }

  private void identify(AuthenticationFlowContext context, MultivaluedMap<String, String> form) {
    if (normalLogin(context)) {
      org.keycloak.authentication.authenticators.util.AuthenticatorUtils.processRememberMe(context, form);
    }
    String email = trim(form.getFirst("email")).toLowerCase(java.util.Locale.ROOT);
    if (!java.util.Objects.equals(email, identifier(context))) clearCode(context);
    context.clearUser(); context.getAuthenticationSession().removeAuthNote("tentu.registration_verified");
    if (email.length() > 254 || !email.matches("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")) { challengeDetails(context, "emailOtpInvalidEmail"); return; }
    UserModel user = context.getSession().users().getUserByEmail(context.getRealm(), email);
    context.getAuthenticationSession().setAuthNote("tentu.identifier", email);
    if (user != null) {
      context.setUser(user);
      String pending=user.getFirstAttribute("tentu.registration.invitation");
      if(pending!=null && context.getAuthenticationSession().getAuthNote(InvitationStore.NOTE)==null) context.getAuthenticationSession().setAuthNote(InvitationStore.NOTE,pending);
    }
    if (context.getAuthenticationSession().getAuthNote(InvitationStore.NOTE) != null && user != null && !"true".equals(user.getFirstAttribute(InvitationStore.PROVISIONAL))) {
      context.failureChallenge(org.keycloak.authentication.AuthenticationFlowError.INVALID_USER, context.form().setError("tentuInvitationExistingAccount").createErrorPage(Response.Status.CONFLICT)); return;
    }
    if (!normalLogin(context)) {
      if (user != null && user.getId().equals(context.getAuthenticationSession().getAuthNote("tentu.remember.previous_user")))
        context.getAuthenticationSession().setAuthNote(org.keycloak.events.Details.REMEMBER_ME, "true");
      else context.getAuthenticationSession().removeAuthNote(org.keycloak.events.Details.REMEMBER_ME);
    }
    startMethod(context, preferredMethod(user));
  }

  private void register(AuthenticationFlowContext context, MultivaluedMap<String, String> form) {
    if (!"true".equals(context.getAuthenticationSession().getAuthNote("tentu.registration_verified")) || parseLong(context.getAuthenticationSession().getAuthNote("tentu.registration.expires")) <= Instant.now().getEpochSecond() || !java.util.Objects.equals(identifier(context), context.getAuthenticationSession().getAuthNote("tentu.registration.email"))) { challengeDetails(context, "emailOtpInvalidCode"); return; }
    String email = identifier(context);
    String firstName = trim(form.getFirst("firstName"));
    String lastName = trim(form.getFirst("lastName"));
    if (!email.matches("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$") || !RegistrationPolicy.validName(context.getSession(), firstName, true) || !RegistrationPolicy.validName(context.getSession(), lastName, true)) { challengeRegistration(context, email, "emailOtpInvalidDetails"); return; }
    if (!"true".equals(form.getFirst("terms")) || !"true".equals(form.getFirst("privacy"))) { challengeRegistration(context, email, "emailOtpConsentRequired"); return; }
    UserModel user = context.getUser();
    boolean created = user == null;
    if (created) {
      String lock = "tentu-registration-create:" + EmailOtpRateLimit.recipientKey(context, email);
      if (!context.getSession().singleUseObjects().putIfAbsent(lock, 30)) {
        challengeRegistration(context, email, "emailOtpRegistrationConflict"); return;
      }
      context.getSession().getTransactionManager().enlistAfterCompletion(new org.keycloak.models.AbstractKeycloakTransaction() {
        protected void commitImpl() { context.getSession().singleUseObjects().remove(lock); }
        protected void rollbackImpl() { context.getSession().singleUseObjects().remove(lock); }
      });
      user = context.getSession().users().getUserByEmail(context.getRealm(), email);
      if (user != null) {
        context.getAuthenticationSession().removeAuthNote("tentu.registration_verified");
        if (context.getAuthenticationSession().getAuthNote(InvitationStore.NOTE) != null) {
          challengeDetails(context, "tentuInvitationExistingAccount"); return;
        }
        context.setUser(user);
        startMethod(context, preferredMethod(user)); return;
      }
      try {
        user = context.getSession().users().addUser(context.getRealm(), "score-" + java.util.UUID.randomUUID());
        user.setEmail(email); user.setEnabled(true); user.setEmailVerified(true);
        user.setSingleAttribute(InvitationStore.PROVISIONAL, "true");
        context.getSession().getProvider(org.keycloak.connections.jpa.JpaConnectionProvider.class).getEntityManager().flush();
        context.setUser(user);
      } catch (RuntimeException error) {
        if (!PersistenceConflicts.duplicate(error)) throw error;
        context.getSession().getTransactionManager().setRollbackOnly();
        context.failureChallenge(org.keycloak.authentication.AuthenticationFlowError.INVALID_USER,
            context.form().setError("emailOtpRegistrationConflict").createErrorPage(Response.Status.CONFLICT)); return;
      }
    }
    if (!user.isEnabled() || context.getProtector().isTemporarilyDisabled(context.getSession(), context.getRealm(), user)) {
      challengeDetails(context, "emailOtpInvalidCode"); return;
    }
    try {
      if (context.getAuthenticationSession().getAuthNote(InvitationStore.NOTE) != null)
        new InvitationStore(context.getSession()).redeem(context.getAuthenticationSession(), user);
      else if (created) {
        var role = RegistrationPolicy.publicDefaultRole(context.getRealm());
        if (role != null) user.grantRole(role);
      }
    }
    catch (jakarta.ws.rs.ClientErrorException error) {
      context.getSession().getTransactionManager().setRollbackOnly();
      context.failureChallenge(org.keycloak.authentication.AuthenticationFlowError.INVALID_USER,
        context.form().setError("tentuInvitationUnavailable").createErrorPage(Response.Status.CONFLICT)); return;
    }
    user.removeAttribute(InvitationStore.PROVISIONAL);
    user.removeAttribute("tentu.registration.invitation");
    user.setSingleAttribute("tentuRegistrationCompletedAt", Instant.now().toString());
    {
      user.setFirstName(firstName);
      user.setLastName(lastName);
      LegalDocuments.record(context, user);
      String timestamp = Instant.now().toString();
      user.setSingleAttribute("tentuCreatedAt", timestamp);
      user.setSingleAttribute("tentuUpdatedAt", timestamp);
    }
    context.getAuthenticationSession().removeAuthNote("tentu.registration_verified");
    verifiedContext(context, "email-otp").success();
  }

  void beginVerification(AuthenticationFlowContext context) {
    var user=context.getUser();
    String scope=context.getAuthenticationSession().getAuthNote(StepUpResourceFactory.NOTE);
    if(scope!=null && scope.startsWith("user:")) startMethod(context,"passkey");
    else startMethod(context,AuthenticationPolicy.hasPasskey(user) ? "passkey" : hasTotp(user) ? "totp" : "email");
  }
  private void challengeMethods(AuthenticationFlowContext context, String error) {
    challengeMethods(context, error, null);
  }
  private void challengeMethods(AuthenticationFlowContext context, String error, String excludeMethod) {
    UserModel user = context.getUser();
    boolean adminPasskey = AuthenticationPolicy.isAdmin(context.getRealm(), user) && AuthenticationPolicy.hasPasskey(user);
    var form = signInChallengeForm(context).setAttribute("stage", "methods")
        .setAttribute("hasPasskey", AuthenticationPolicy.hasPasskey(user) && !"passkey".equals(excludeMethod))
        .setAttribute("hasTotp", !adminPasskey && hasTotp(user) && !"totp".equals(excludeMethod))
        .setAttribute("hasEmail", !adminPasskey && hasEmail(user) && !"email".equals(excludeMethod))
        .setAttribute("adminPasskey", adminPasskey)
        .setAttribute("allowOtherMethods", false);
    if (error != null) form.setError(error);
    context.challenge(form.createForm("email-otp.ftl"));
  }
  private static String preferredMethod(UserModel user) {
    if (AuthenticationPolicy.hasPasskey(user)) return "passkey";
    if (hasTotp(user)) return "totp";
    return "email";
  }
  private static boolean hasTotp(UserModel user) {
    return user != null && user.credentialManager().isConfiguredFor("otp");
  }
  private static boolean hasEmail(UserModel user) {
    return user != null && trim(user.getEmail()).matches("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$");
  }
  private static boolean hasOtherMethod(RealmModel realm, UserModel user, String selected) {
    if (user == null) return false;
    if (AuthenticationPolicy.isAdmin(realm, user) && AuthenticationPolicy.hasPasskey(user)) return false;
    return (AuthenticationPolicy.hasPasskey(user) && !"passkey".equals(selected))
        || (hasTotp(user) && !"totp".equals(selected))
        || (hasEmail(user) && !"email".equals(selected));
  }
  private AuthenticationFlowContext verifiedContext(AuthenticationFlowContext context, String method) {
    return AuthenticationPolicy.onSuccess(AuthenticationFlowContext.class, context, () -> {
      enforceClientAccess(context);
      if (AuthenticationPolicy.isAdmin(context.getRealm(), context.getUser())) {
        if (AuthenticationPolicy.hasPasskey(context.getUser()) && !AuthenticationPolicy.PASSKEY.equals(method))
          throw new jakarta.ws.rs.ForbiddenException("Passkey required");
        if (!AuthenticationPolicy.hasPasskey(context.getUser())) context.getAuthenticationSession().addRequiredAction(AuthenticationPolicy.REGISTER);
      }
      StepUpResourceFactory.complete(context,method);
      AuthenticationPolicy.record(context.getAuthenticationSession(), context.getRealm(), context.getUser(), method);
    });
  }
  private void startMethod(AuthenticationFlowContext context, String method) {
    var user = context.getUser();
    if (user == null && "email".equals(method)) {
      String email = identifier(context);
      if (email == null) { challengeDetails(context, "emailOtpInvalidCode"); return; }
      sendCode(context, null, email, false); return;
    }
    if (user == null || !user.isEnabled() || context.getProtector().isTemporarilyDisabled(context.getSession(), context.getRealm(), user)) { challengeDetails(context, "emailOtpInvalidCode"); return; }
    if (AuthenticationPolicy.isAdmin(context.getRealm(), user) && AuthenticationPolicy.hasPasskey(user) && !"passkey".equals(method)) { challengeMethods(context, "tentuPasskeyRequired"); return; }
    if (!"email".equals(method)) clearCode(context);
    context.getAuthenticationSession().setAuthNote(METHOD, method == null ? "" : method);
    boolean adminPasskey = AuthenticationPolicy.isAdmin(context.getRealm(), user) && AuthenticationPolicy.hasPasskey(user);
    signInChallengeForm(context).setAttribute("allowOtherMethods", !adminPasskey && hasOtherMethod(context.getRealm(), user, method));
    context.form().setAttribute("selectedMethod", method);
    if ("passkey".equals(method) && AuthenticationPolicy.hasPasskey(user)) {
      new org.keycloak.authentication.authenticators.browser.WebAuthnPasswordlessAuthenticator(context.getSession()).authenticate(verifiedContext(context, AuthenticationPolicy.PASSKEY));
    } else if ("totp".equals(method) && user.credentialManager().isConfiguredFor("otp")) {
      new org.keycloak.authentication.authenticators.browser.OTPFormAuthenticator().authenticate(verifiedContext(context, "otp"));
    } else if ("email".equals(method)) { sendCode(context, user, user.getEmail(), false); }
    else { challengeMethods(context, "emailOtpInvalidCode"); }
  }
  private void clearCode(AuthenticationFlowContext context) {
    context.getAuthenticationSession().removeAuthNote(CODE_HASH);
    context.getAuthenticationSession().removeAuthNote(EXPIRES_AT);
  }
  private void challengeCode(AuthenticationFlowContext context, String error) {
    UserModel user = context.getUser();
    var form = signInChallengeForm(context).setAttribute("stage", "verify")
        .setAttribute("otpCooldownSeconds", EmailOtpRateLimit.cooldown(context))
        .setAttribute("allowOtherMethods", hasOtherMethod(context.getRealm(), user, "email"))
        .setAttribute("selectedMethod", "email")
        .setAttribute("email", maskedEmail(identifier(context)));
    if (error != null) form.setError(error);
    context.challenge(form.createForm("email-otp.ftl"));
  }
  private static String maskedEmail(String email) { return email.replaceAll("(?<=.).(?=[^@]*@)", "•"); }

  private void sendCode(AuthenticationFlowContext context, UserModel user, String email, boolean resend) {
    if (user != null) context.setUser(user);
    if (user != null && (!user.isEnabled() || context.getProtector().isTemporarilyDisabled(context.getSession(), context.getRealm(), user))) { challengeDetails(context, "emailOtpInvalidCode"); return; }
    if (AuthenticationPolicy.isAdmin(context.getRealm(), user) && AuthenticationPolicy.hasPasskey(user)) { challengeMethods(context, "tentuPasskeyRequired"); return; }
    String recipient = EmailOtpRateLimit.recipientKey(context, email);
    context.getAuthenticationSession().setAuthNote(METHOD, "email");
    if (!EmailOtpRateLimit.reserve(context, recipient)) { challengeCode(context, "emailOtpResendWait"); return; }
    clearCode(context);
    context.getAuthenticationSession().setAuthNote(METHOD, "email");
    String code = String.format("%06d", RANDOM.nextInt(1_000_000));
    context.getAuthenticationSession().setAuthNote(CODE_HASH, hash(code));
    context.getAuthenticationSession().setAuthNote(EXPIRES_AT, Long.toString(Instant.now().getEpochSecond() + LIFESPAN_SECONDS));
    context.getAuthenticationSession().setAuthNote(ATTEMPTS, "0");
    context.getSession().singleUseObjects().put("tentu-otp-active:" + recipient, LIFESPAN_SECONDS,
        Map.of("hash", hash(code), "session", context.getAuthenticationSession().getParentSession().getId()));
    try {
      EmailTemplateProvider emailProvider = context.getSession().getProvider(EmailTemplateProvider.class);
      emailProvider.setRealm(context.getRealm());
      emailProvider.setUser(user == null ? RegistrationPolicy.pendingRecipient(email) : user);
      // Keycloak adds locale, realm and user attributes while rendering the email.
      emailProvider.send("emailOtpSubject", List.of(), "email-otp.ftl",
          new HashMap<>(Map.of("code", code, "minutes", LIFESPAN_SECONDS / 60)));
    } catch (Exception exception) {
      Throwable cause = exception;
      for (int depth = 0; depth < 10 && cause.getCause() != null && cause.getCause() != cause; depth++) {
        cause = cause.getCause();
      }
      // Exception messages and stacks may include template values or SMTP credentials.
      LOG.warnf("Email OTP delivery failed: exception=%s cause=%s",
          exception.getClass().getSimpleName(), cause.getClass().getSimpleName());
      context.failureChallenge(org.keycloak.authentication.AuthenticationFlowError.INTERNAL_ERROR,
          signInChallengeForm(context).setError("emailOtpDeliveryFailed").createErrorPage(Response.Status.INTERNAL_SERVER_ERROR));
      return;
    }
    challengeCode(context, null);
  }

  private void verify(AuthenticationFlowContext context, String submittedCode) {
    long expiresAt = parseLong(context.getAuthenticationSession().getAuthNote(EXPIRES_AT));
    int attempts = (int) parseLong(context.getAuthenticationSession().getAuthNote(ATTEMPTS));
    String recipient = EmailOtpRateLimit.recipientKey(context, identifier(context));
    var active = context.getSession().singleUseObjects().get("tentu-otp-active:" + recipient);
    if (active == null || !constantTimeEquals(active.get("hash"), context.getAuthenticationSession().getAuthNote(CODE_HASH)) || !context.getAuthenticationSession().getParentSession().getId().equals(active.get("session")) || Instant.now().getEpochSecond() >= expiresAt || attempts >= MAX_ATTEMPTS || !constantTimeEquals(context.getAuthenticationSession().getAuthNote(CODE_HASH), hash(trim(submittedCode)))) {
      context.getAuthenticationSession().setAuthNote(ATTEMPTS, Integer.toString(attempts + 1));
      if (attempts >= MAX_ATTEMPTS || Instant.now().getEpochSecond() >= expiresAt) clearCode(context);
      context.failureChallenge(org.keycloak.authentication.AuthenticationFlowError.INVALID_CREDENTIALS,
          signInChallengeForm(context).setAttribute("stage", "verify").setAttribute("allowOtherMethods", hasOtherMethod(context.getRealm(), context.getUser(), "email")).setAttribute("selectedMethod", "email").setAttribute("email", maskedEmail(identifier(context))).setError("emailOtpInvalidCode").createForm("email-otp.ftl"));
      return;
    }
    if (context.getUser() != null && (!context.getUser().isEnabled() || context.getProtector().isTemporarilyDisabled(context.getSession(), context.getRealm(), context.getUser()))) { challengeCode(context, "emailOtpInvalidCode"); return; }
    // Atomically consume the verification proof to reject concurrent duplicate POSTs.
    String proof = context.getAuthenticationSession().getAuthNote(CODE_HASH);
    if (!context.getSession().singleUseObjects().putIfAbsent("tentu-otp-used:" + recipient + ":" + proof, LIFESPAN_SECONDS)) { challengeCode(context, "emailOtpInvalidCode"); return; }
    clearCode(context);
    if (context.getUser() != null) context.getUser().setEmailVerified(true);
    if (context.getUser() == null || "true".equals(context.getUser().getFirstAttribute(InvitationStore.PROVISIONAL)) || trim(context.getUser().getFirstName()).isEmpty()) {
      context.getAuthenticationSession().setAuthNote("tentu.registration_verified", "true");
      context.getAuthenticationSession().setAuthNote("tentu.registration.email", identifier(context));
      context.getAuthenticationSession().setAuthNote("tentu.registration.expires", Long.toString(Instant.now().getEpochSecond() + LIFESPAN_SECONDS));
      challengeRegistration(context, identifier(context)); return;
    }
    verifiedContext(context, "email-otp").success();
  }

  static boolean normalLogin(AuthenticationFlowContext context) {
    var auth = context.getAuthenticationSession();
    return auth.getClientNote("kc_action") == null
        && !"login".equals(auth.getClientNote("prompt"))
        && !"0".equals(auth.getClientNote("max_age"));
  }
  private LoginFormsProvider signInChallengeForm(AuthenticationFlowContext context) {
    var auth = context.getAuthenticationSession();
    return context.form().setAttribute("showSignInRestart",
        auth.getAuthNote(StepUpResourceFactory.NOTE) == null
            && auth.getAuthNote(InvitationStore.NOTE) == null
            && auth.getClientNote("kc_action") == null);
  }

  private void challengeDetails(AuthenticationFlowContext context, String error) {
    var form = context.form().setAttribute("stage", "identify")
        .setAttribute("showRememberMe", context.getRealm().isRememberMe() && normalLogin(context))
        .setAttribute("rememberMeChecked", "true".equals(context.getAuthenticationSession().getAuthNote(org.keycloak.events.Details.REMEMBER_ME)));
    if (error != null) form.setError(error);
    context.challenge(form.createForm("email-otp.ftl"));
  }

  private void challengeRegistration(AuthenticationFlowContext context, String email) { challengeRegistration(context, email, null); }
  private void challengeRegistration(AuthenticationFlowContext context, String email, String error) {
    LegalDocuments.present(context);
    var form = signInChallengeForm(context).setAttribute("stage", "register").setAttribute("email", email)
        .setAttribute("showRegistrationPrivacyNotice", RegistrationNotice.enabled(context));
    if (error != null) form.setError(error);
    context.challenge(form.createForm("email-otp.ftl"));
  }

  private static String identifier(AuthenticationFlowContext context) {
    return context.getUser() != null ? context.getUser().getEmail() : context.getAuthenticationSession().getAuthNote("tentu.identifier");
  }
  private static String trim(String value) { return value == null ? "" : value.trim(); }
  private static void recordDevice(AuthenticationFlowContext context) {
    String agent = context.getHttpRequest().getHttpHeaders().getHeaderString("User-Agent");
    if (agent != null) context.getEvent().detail("user_agent", agent.substring(0, Math.min(agent.length(), 512)));
  }
  private static long parseLong(String value) { try { return Long.parseLong(value); } catch (Exception ignored) { return 0; } }
  private static String hash(String input) { try { return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8))); } catch (Exception e) { throw new IllegalStateException(e); } }
  private static boolean constantTimeEquals(String left, String right) { return left != null && right != null && MessageDigest.isEqual(left.getBytes(StandardCharsets.UTF_8), right.getBytes(StandardCharsets.UTF_8)); }
  @Override public boolean requiresUser() { return false; }
  @Override public boolean configuredFor(KeycloakSession session, RealmModel realm, UserModel user) { return true; }
  @Override public void setRequiredActions(KeycloakSession session, RealmModel realm, UserModel user) { }
  @Override public void close() { }
}
