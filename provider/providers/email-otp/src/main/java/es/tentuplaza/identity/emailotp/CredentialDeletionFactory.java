package es.tentuplaza.identity.emailotp;

import jakarta.ws.rs.core.Response;
import org.keycloak.Config;
import org.keycloak.authentication.InitiatedActionSupport;
import org.keycloak.authentication.RequiredActionContext;
import org.keycloak.authentication.RequiredActionFactory;
import org.keycloak.authentication.RequiredActionProvider;
import org.keycloak.authentication.authenticators.util.AcrStore;
import org.keycloak.authentication.authenticators.util.LoAUtil;
import org.keycloak.events.Details;
import org.keycloak.events.EventBuilder;
import org.keycloak.events.EventType;
import org.keycloak.credential.CredentialModel;
import org.keycloak.models.AuthenticationFlowBindings;
import org.keycloak.models.AuthenticationFlowModel;
import org.keycloak.models.Constants;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.models.utils.AuthenticationFlowResolver;
import org.keycloak.models.credential.OTPCredentialModel;
import org.keycloak.sessions.AuthenticationSessionModel;
import java.util.Map;

/** Self-service deletion for supported TenTu credentials, with server-side safety checks. */
public final class CredentialDeletionFactory implements RequiredActionFactory {
  private static final String ID = "tentu-delete-credential";

  public String getId() { return ID; }
  public String getDisplayText() { return "SCORE safe credential deletion"; }

  public RequiredActionProvider create(KeycloakSession session) {
    return new RequiredActionProvider() {
      public InitiatedActionSupport initiatedActionSupport() { return InitiatedActionSupport.SUPPORTED; }
      public int getMaxAuthAge(KeycloakSession ignored) { return 0; }
      public void evaluateTriggers(RequiredActionContext context) { }

      public void requiredActionChallenge(RequiredActionContext context) {
        CredentialModel credential = targetCredential(context);
        if (credential == null || !isSupported(credential)) {
          showError(context, "credentialNotFound", Response.Status.NOT_FOUND);
          return;
        }
        if (isLastAdministrativePasskey(context, credential)) {
          showError(context, "tentuLastPasskey", Response.Status.FORBIDDEN);
          return;
        }
        context.challenge(context.form()
            .setAttribute("credentialLabel", label(credential))
            .createForm("delete-credential.ftl"));
      }

      public void processAction(RequiredActionContext context) {
        CredentialMutationLock.acquire(context.getSession(), context.getRealm(), context.getUser());
        CredentialModel credential = targetCredential(context);
        if (credential == null || !isSupported(credential)) {
          showError(context, "credentialNotFound", Response.Status.NOT_FOUND);
          return;
        }
        if (isLastAdministrativePasskey(context, credential)) {
          showError(context, "tentuLastPasskey", Response.Status.FORBIDDEN);
          return;
        }
        if (!hasEnoughAuthentication(context, credential.getType())) {
          showError(context, "tentuCredentialRemovalRequiresRecentLogin", Response.Status.FORBIDDEN);
          return;
        }

        boolean removed = context.getUser().credentialManager().removeStoredCredentialById(credential.getId());
        if (!removed) {
          showError(context, "credentialNotFound", Response.Status.NOT_FOUND);
          return;
        }
        EventBuilder event = context.getEvent().event(EventType.REMOVE_CREDENTIAL)
            .detail(Details.CREDENTIAL_TYPE, credential.getType())
            .detail(Details.CREDENTIAL_ID, credential.getId())
            .detail(Details.CREDENTIAL_USER_LABEL, credential.getUserLabel());
        EventBuilder totpEvent = OTPCredentialModel.TYPE.equals(credential.getType())
            ? event.clone().event(EventType.REMOVE_TOTP)
            : null;
        event.success();
        if (totpEvent != null) totpEvent.success();
        context.success();
      }

      public void close() { }
    };
  }

  private static CredentialModel targetCredential(RequiredActionContext context) {
    String id = context.getAuthenticationSession().getClientNote(Constants.KC_ACTION_PARAMETER);
    return id == null ? null : context.getUser().credentialManager().getStoredCredentialById(id);
  }

  private static boolean isSupported(CredentialModel credential) {
    return OTPCredentialModel.TYPE.equals(credential.getType())
        || AuthenticationPolicy.PASSKEY.equals(credential.getType());
  }

  private static String label(CredentialModel credential) {
    return credential.getUserLabel() == null || credential.getUserLabel().isBlank()
        ? credential.getType()
        : credential.getUserLabel();
  }

  private static boolean isLastAdministrativePasskey(RequiredActionContext context, CredentialModel credential) {
    return AuthenticationPolicy.PASSKEY.equals(credential.getType())
        && AuthenticationPolicy.isAdmin(context.getRealm(), context.getUser())
        && context.getUser().credentialManager()
            .getStoredCredentialsByTypeStream(AuthenticationPolicy.PASSKEY).count() <= 1;
  }

  private static boolean hasEnoughAuthentication(RequiredActionContext context, String credentialType) {
    AuthenticationSessionModel authSession = context.getAuthenticationSession();
    AuthenticationFlowModel flow = AuthenticationFlowResolver.resolveBindingOverrideFlowForClient(
        authSession.getClient(), AuthenticationFlowBindings.BROWSER_BINDING);
    if (flow == null) flow = context.getRealm().getBrowserFlow();

    Map<String, Integer> requestedLevels = LoAUtil.getCredentialTypesToLoAMap(
        context.getSession(), context.getRealm(), flow);
    int requiredLevel = requestedLevels.getOrDefault(credentialType, Constants.NO_LOA);
    int currentLevel = new AcrStore(context.getSession(), authSession)
        .getLevelOfAuthenticationFromCurrentAuthentication();
    return currentLevel >= requiredLevel;
  }

  private static void showError(RequiredActionContext context, String message, Response.Status status) {
    context.challenge(context.form().setError(message).createErrorPage(status));
  }

  public void init(Config.Scope config) { }
  public void postInit(KeycloakSessionFactory factory) { }
  public void close() { }
}
