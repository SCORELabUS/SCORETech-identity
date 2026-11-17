package es.tentuplaza.identity.emailotp;

import java.util.List;
import org.keycloak.models.*;
import org.keycloak.protocol.oidc.mappers.*;
import org.keycloak.provider.ProviderConfigProperty;
import org.keycloak.representations.IDToken;
import org.keycloak.representations.AccessToken;

/** Executed on issuance AND refresh, checking current effective roles and credentials. */
public final class AuthenticationPolicyMapper extends AbstractOIDCProtocolMapper implements OIDCAccessTokenMapper, OIDCIDTokenMapper, TokenIntrospectionTokenMapper, UserInfoTokenMapper {

  // Run after standard scope mappers so they cannot reintroduce unselected fields.
  @Override public int getPriority() { return Integer.MAX_VALUE; }

  public String getId() { return "tentu-authentication-policy"; }
  public String getDisplayType() { return "SCORE authentication policy"; }
  public String getDisplayCategory() { return "Token mapper"; }
  public String getHelpText() { return "Rejects administrative tokens without server-attested passwordless authentication."; }
  public List<ProviderConfigProperty> getConfigProperties() { return List.of(); }
  @Override public AccessToken transformAccessToken(AccessToken token, ProtocolMapperModel model, KeycloakSession session, UserSessionModel userSession, ClientSessionContext client) {
    setClaim(token, model, userSession, session, client);
    ApplicationUserClaims.apply(token, userSession.getUser(), client, false, false);
    return token;
  }

  @Override public IDToken transformIDToken(IDToken token, ProtocolMapperModel model, KeycloakSession session, UserSessionModel userSession, ClientSessionContext client) {
    setClaim(token, model, userSession, session, client);
    ApplicationUserClaims.apply(token, userSession.getUser(), client, true, true);
    return token;
  }

  @Override public AccessToken transformUserInfoToken(AccessToken token, ProtocolMapperModel model, KeycloakSession session, UserSessionModel userSession, ClientSessionContext client) {
    ApplicationUserClaims.apply(token, userSession.getUser(), client, true, false);
    return token;
  }

  @Override public AccessToken transformIntrospectionToken(AccessToken token, ProtocolMapperModel model, KeycloakSession session, UserSessionModel userSession, ClientSessionContext client) {
    setClaim(token, model, userSession, session, client);
    ApplicationUserClaims.apply(token, userSession.getUser(), client, false, false);
    return token;
  }

  @Override protected void setClaim(IDToken token, ProtocolMapperModel model, UserSessionModel userSession, KeycloakSession session, ClientSessionContext client) {
    var user = userSession.getUser();
    // Service accounts retain their narrowly scoped machine credentials.
    var clientSession=client==null?null:client.getClientSession();
    ClientAccessRules.enforce(userSession.getRealm(), user, clientSession==null?null:clientSession.getClient(), clientSession==null?null:clientSession.getRedirectUri());
    if (user.getServiceAccountClientLink() != null) return;
    boolean admin = AuthenticationPolicy.isAdmin(userSession.getRealm(), user);
    String method = userSession.getNote(AuthenticationPolicy.METHOD);
    if (admin && (!"true".equals(userSession.getNote(AuthenticationPolicy.ADMIN)) || !AuthenticationPolicy.PASSKEY.equals(method) || !AuthenticationPolicy.hasPasskey(user)))
      throw new jakarta.ws.rs.ForbiddenException("Administrative passkey authentication required");
    String scope=userSession.getNote(StepUpResourceFactory.NOTE);
    if(scope!=null) token.getOtherClaims().put("tentu_step_up",scope);
    token.getOtherClaims().put("tentu_auth_method", method == null ? "legacy" : method);
    token.getOtherClaims().put("tentu_admin_verified", admin);
  }
}
