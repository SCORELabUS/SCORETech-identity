package es.tentuplaza.identity.emailotp;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import org.keycloak.models.*;
import org.keycloak.protocol.oidc.mappers.*;
import org.keycloak.provider.ProviderConfigProperty;
import org.keycloak.representations.IDToken;
import org.keycloak.util.JsonSerialization;

/** Executed on issuance AND refresh, checking current effective roles and credentials. */
public final class AuthenticationPolicyMapper extends AbstractOIDCProtocolMapper implements OIDCAccessTokenMapper, OIDCIDTokenMapper, TokenIntrospectionTokenMapper {

  public String getId() { return "tentu-authentication-policy"; }
  public String getDisplayType() { return "SCORE authentication policy"; }
  public String getDisplayCategory() { return "Token mapper"; }
  public String getHelpText() { return "Rejects administrative tokens without server-attested passwordless authentication."; }
  public List<ProviderConfigProperty> getConfigProperties() { return List.of(); }
  @Override public org.keycloak.representations.AccessToken transformAccessToken(org.keycloak.representations.AccessToken token, ProtocolMapperModel model, KeycloakSession session, UserSessionModel userSession, ClientSessionContext client) {
    setClaim(token, model, userSession, session, client); return token;
  }
  @Override public IDToken transformIDToken(IDToken token, ProtocolMapperModel model, KeycloakSession session, UserSessionModel userSession, ClientSessionContext client) {
    setClaim(token, model, userSession, session, client);
    var clientSession = client == null ? null : client.getClientSession();
    if (clientSession != null && userSession.getUser().getServiceAccountClientLink() == null
        && "true".equals(clientSession.getClient().getAttribute("scoretech.shared-display-name"))
        && client.getClientScopesStream().anyMatch(scope -> "profile".equals(scope.getName()))) {
      token.getOtherClaims().put("scoretech_display_name", sharedDisplayName(userSession.getUser()));
    }
    return token;
  }

  private static String sharedDisplayName(UserModel user) {
    String raw = user.getFirstAttribute("scoreProfile");
    if (raw == null || raw.isBlank()) return "";
    try {
      var profile = JsonSerialization.readValue(raw, Map.class);
      if (profile != null && profile.get("displayName") instanceof String value) {
        String name = value.strip();
        if (name.length() <= 100) return name;
      }
    } catch (IOException ignored) {
      // Invalid legacy profile data must not prevent sign-in.
    }
    return "";
  }

  @Override public org.keycloak.representations.AccessToken transformIntrospectionToken(org.keycloak.representations.AccessToken token, ProtocolMapperModel model, KeycloakSession session, UserSessionModel userSession, ClientSessionContext client) {
    setClaim(token, model, userSession, session, client); return token;
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
