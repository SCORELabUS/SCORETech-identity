package es.tentuplaza.identity.emailotp;

import jakarta.ws.rs.core.Response;
import org.keycloak.Config;
import org.keycloak.authentication.*;
import org.keycloak.events.EventType;
import org.keycloak.models.*;
import org.keycloak.services.managers.AuthenticationSessionManager;

/** Self-service deletion stays in the native, CSRF-bound action after fresh authentication. */
public final class AccountDeletionFactory implements RequiredActionFactory {
  public String getId() { return "score-delete-account"; }
  public String getDisplayText() { return "Delete SCORETech identity"; }
  public RequiredActionProvider create(KeycloakSession session) { return new RequiredActionProvider() {
    public InitiatedActionSupport initiatedActionSupport() { return InitiatedActionSupport.SUPPORTED; }
    public int getMaxAuthAge(KeycloakSession ignored) { return 0; }
    public void evaluateTriggers(RequiredActionContext context) { }
    private boolean allowed(RequiredActionContext c) {
      var user = c.getUser();
      var authenticated = c.getAuthenticationSession().getAuthenticatedUser();
      return "identity-account-web".equals(c.getAuthenticationSession().getClient().getClientId())
          && user != null && user.isEnabled() && user.getId() != null
          && authenticated != null && user.getId().equals(authenticated.getId())
          && !AuthenticationPolicy.isAdmin(c.getRealm(), user)
          && (c.getRealm().getRole("admin") == null || !user.hasRole(c.getRealm().getRole("admin")));
    }
    private void deny(RequiredActionContext c) {
      c.challenge(c.form().setError("Administrative accounts are protected. Ask another administrator to remove your administrative access before deleting your identity.").createErrorPage(Response.Status.FORBIDDEN));
    }
    public void requiredActionChallenge(RequiredActionContext c) {
      if (!allowed(c)) { deny(c); return; }
      c.challenge(c.form().setAttribute("confirmationEmail", c.getUser().getEmail()).createForm("delete-identity.ftl"));
    }
    public void processAction(RequiredActionContext c) {
      var form = c.getHttpRequest().getDecodedFormParameters();
      if ("cancel".equals(form.getFirst("decision"))) { c.success(); return; }
      if (!allowed(c)) { deny(c); return; }
      if (!"delete".equals(form.getFirst("decision")) || c.getUser().getEmail() == null
          || !c.getUser().getEmail().equals(form.getFirst("confirmation"))) {
        c.challenge(c.form().setError("Type your email address to confirm deletion.")
            .setAttribute("confirmationEmail", c.getUser().getEmail()).createForm("delete-identity.ftl"));
        return;
      }
      AuthorizationResourceFactory.acquire(c.getSession(), c.getRealm());
      CredentialMutationLock.acquire(c.getSession(), c.getRealm(), c.getUser());
      if (!allowed(c)) { deny(c); return; }
      var user = c.getUser();
      var event = c.getEvent().event(EventType.DELETE_ACCOUNT).user(user);
      if (!new UserManager(c.getSession()).removeUser(c.getRealm(), user)) {
        c.challenge(c.form().setError("Unable to delete this identity. Try again later.").createErrorPage(Response.Status.CONFLICT));
        return;
      }
      event.success();
      new AuthenticationSessionManager(c.getSession()).removeAuthenticationSession(c.getRealm(), c.getAuthenticationSession(), true);
      c.challenge(c.form().setAttribute("messageHeader", "Identity deleted")
          .setInfo("Your SCORETech Identity account has been deleted. Your data in other SCORE services must be managed separately.")
          .createForm("info.ftl"));
    }
    public void close() { }
  }; }
  public void init(Config.Scope config) { }
  public void postInit(KeycloakSessionFactory factory) { }
  public void close() { }
}
