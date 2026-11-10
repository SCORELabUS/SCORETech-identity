package es.tentuplaza.identity.emailotp;

import jakarta.ws.rs.core.Response;
import org.keycloak.Config;
import org.keycloak.authentication.*;
import org.keycloak.events.EventType;
import org.keycloak.models.*;

/** Native AIA: fresh authentication, explicit confirmation and locked last-method protection. */
public final class IdentityUnlinkFactory implements RequiredActionFactory {
  public String getId() { return "score-unlink-identity"; }
  public String getDisplayText() { return "Disconnect external identity"; }
  public RequiredActionProvider create(KeycloakSession session) { return new RequiredActionProvider() {
    public InitiatedActionSupport initiatedActionSupport() { return InitiatedActionSupport.SUPPORTED; }
    public int getMaxAuthAge(KeycloakSession ignored) { return 0; }
    public void evaluateTriggers(RequiredActionContext context) { }
    private String alias(RequiredActionContext c) { return c.getAuthenticationSession().getClientNote(Constants.KC_ACTION_PARAMETER); }
    private boolean allowed(RequiredActionContext c, String alias) {
      return "identity-account-web".equals(c.getAuthenticationSession().getClient().getClientId())
          && c.getUser()!=null && c.getUser().isEnabled() && alias != null && IdentityLinks.ALIASES.contains(alias)
          && c.getSession().users().getFederatedIdentity(c.getRealm(),c.getUser(),alias)!=null
          && IdentityLinks.canDisconnect(c.getSession(),c.getRealm(),c.getUser(),alias);
    }
    private void deny(RequiredActionContext c) {
      c.challenge(c.form().setError("Verify your email address or connect another sign-in provider before disconnecting this identity.").createErrorPage(Response.Status.FORBIDDEN));
    }
    public void requiredActionChallenge(RequiredActionContext c) {
      String alias=alias(c);
      if(!allowed(c,alias)) { deny(c);return; }
      c.challenge(c.form().setAttribute("providerName",alias.equals("google")?"Google":"Universidad de Sevilla").createForm("unlink-identity.ftl"));
    }
    public void processAction(RequiredActionContext c) {
      if(!"disconnect".equals(c.getHttpRequest().getDecodedFormParameters().getFirst("decision"))) { c.success();return; }
      CredentialMutationLock.acquire(c.getSession(),c.getRealm(),c.getUser());
      String alias=alias(c);
      if(!allowed(c,alias)) { deny(c);return; }
      if(!c.getSession().users().removeFederatedIdentity(c.getRealm(),c.getUser(),alias)) { deny(c);return; }
      c.getEvent().event(EventType.REMOVE_FEDERATED_IDENTITY).detail("identity_provider",alias).success();
      c.success();
    }
    public void close() { }
  }; }
  public void init(Config.Scope config) { }
  public void postInit(KeycloakSessionFactory factory) { }
  public void close() { }
}
