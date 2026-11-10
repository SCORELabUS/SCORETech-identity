package es.tentuplaza.identity.emailotp;

import org.keycloak.Config;
import org.keycloak.authentication.*;
import org.keycloak.models.*;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.HashSet;
import java.util.Set;

/** Wrap native passwordless enrolment so mandatory onboarding attests possession before tokens. */
public final class PasskeyRegistrationFactory implements RequiredActionFactory {
  public String getId() { return AuthenticationPolicy.REGISTER; }
  public String getDisplayText() { return "SCORE passwordless passkey registration"; }
  public RequiredActionProvider create(KeycloakSession session) {
    var factory = (RequiredActionFactory) session.getKeycloakSessionFactory().getProviderFactory(RequiredActionProvider.class, "webauthn-register-passwordless");
    var nativeAction = factory.create(session);
    return new RequiredActionProvider() {
      public InitiatedActionSupport initiatedActionSupport() { return InitiatedActionSupport.SUPPORTED; }
      // Keycloak checks server-owned AUTH_TIME before reusing the SSO session.
      public int getMaxAuthAge(KeycloakSession ignored) { return 300; }
      public void evaluateTriggers(RequiredActionContext context) {
        if (AuthenticationPolicy.isAdmin(context.getRealm(), context.getUser()) && !AuthenticationPolicy.hasPasskey(context.getUser()))
          context.getAuthenticationSession().addRequiredAction(getId());
      }
      public void requiredActionChallenge(RequiredActionContext context) {
        context.form().setAttribute("administrativeRegistration", AuthenticationPolicy.isAdmin(context.getRealm(), context.getUser()));
        context.form().setAttribute("defaultPasskeyLabel", nextPasskeyLabel(context));
        nativeAction.requiredActionChallenge(context);
      }
      public void processAction(RequiredActionContext context) {
        context.getHttpRequest().getDecodedFormParameters()
            .putSingle("authenticatorLabel", nextPasskeyLabel(context));
        nativeAction.processAction(AuthenticationPolicy.onSuccess(RequiredActionContext.class, context, () -> {
          if (!AuthenticationPolicy.hasPasskey(context.getUser())) throw new jakarta.ws.rs.ForbiddenException("Passkey required");
          AuthenticationPolicy.record(context.getAuthenticationSession(), context.getRealm(), context.getUser(), AuthenticationPolicy.PASSKEY);
        }));
      }
      public void close() { nativeAction.close(); }
    };
  }
  private static String nextPasskeyLabel(RequiredActionContext context) {
    String base = "Passkey created on " + LocalDate.now(ZoneId.of("Europe/Madrid")).format(DateTimeFormatter.ofPattern("dd/MM/yy"));
    Set<String> labels = new HashSet<>();
    context.getUser().credentialManager()
        .getStoredCredentialsByTypeStream(AuthenticationPolicy.PASSKEY)
        .map(org.keycloak.credential.CredentialModel::getUserLabel)
        .filter(label -> label != null && !label.isBlank())
        .forEach(labels::add);
    if (!labels.contains(base)) return base;
    for (int suffix = 2; ; suffix++) {
      String candidate = base + " (" + suffix + ")";
      if (!labels.contains(candidate)) return candidate;
    }
  }
  public void init(Config.Scope config) { }
  public void postInit(KeycloakSessionFactory factory) { }
  public void close() { }
}
