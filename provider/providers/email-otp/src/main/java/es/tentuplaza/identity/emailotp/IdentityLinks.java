package es.tentuplaza.identity.emailotp;

import java.util.*;
import org.keycloak.models.*;

/** Federated identity metadata and last-method policy; never returns provider tokens. */
final class IdentityLinks {
  static final Set<String> ALIASES = Set.of("google", "us-sso");
  static IdentityProviderModel provider(KeycloakSession session, String alias) {
    return ALIASES.contains(alias) ? session.identityProviders().getByAlias(alias) : null;
  }
  static boolean canDisconnect(KeycloakSession session, RealmModel realm, UserModel user, String alias) {
    if (AuthenticationPolicy.isAdmin(realm, user) && !AuthenticationPolicy.hasPasskey(user)) return false;
    if (user.isEmailVerified() && user.getEmail() != null && !user.getEmail().isBlank()) return true;
    // Local factors must also satisfy the realm mailbox policy on their next login.
    if (!realm.isVerifyEmail() && (AuthenticationPolicy.hasPasskey(user) || user.credentialManager().isConfiguredFor("otp"))) return true;
    return session.users().getFederatedIdentitiesStream(realm,user)
        .filter(link -> !alias.equals(link.getIdentityProvider()))
        .anyMatch(link -> {
          var model = session.identityProviders().getByAlias(link.getIdentityProvider());
          return model != null && model.isEnabled() && !Boolean.TRUE.equals(model.isLinkOnly());
        });
  }
  static List<Map<String,Object>> list(KeycloakSession session, RealmModel realm, UserModel user) {
    var result = new ArrayList<Map<String,Object>>();
    for (String alias : List.of("google", "us-sso")) {
      var model = provider(session,alias);
      var link = session.users().getFederatedIdentity(realm,user,alias);
      boolean enabled = model != null && model.isEnabled();
      var row = new LinkedHashMap<String,Object>();
      row.put("alias",alias);row.put("displayName",alias.equals("google") ? "Google" : "Universidad de Sevilla");
      row.put("enabled",enabled);row.put("linked",link != null);
      boolean allowed = link != null && canDisconnect(session,realm,user,alias);
      row.put("canDisconnect",allowed);
      if (link != null && link.getUserName() != null) row.put("externalUsername",link.getUserName());
      if (link != null && !allowed) row.put("disconnectReason","Verify your email address or connect another sign-in provider before disconnecting this identity.");
      result.add(row);
    }
    return result;
  }
}
