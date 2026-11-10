package es.tentuplaza.identity.emailotp;

import jakarta.ws.rs.core.Response;
import org.keycloak.authentication.actiontoken.ActionTokenContext;
import org.keycloak.authentication.actiontoken.updateemail.*;

/** Higher-order native handler still owns signature, expiry, email validation and mutation. */
public final class LatestUpdateEmailTokenHandler extends UpdateEmailActionTokenHandler {
  @Override public int order() { return 10; }
  @Override public Response handleToken(UpdateEmailActionToken token, ActionTokenContext<UpdateEmailActionToken> context) {
    var latest = context.getSession().singleUseObjects().get(LatestUpdateEmail.key(context.getRealm().getId(), token.getUserId()));
    if (latest == null || !token.getActionVerificationNonce().toString().equals(latest.get("nonce"))) {

      return context.getSession().getProvider(org.keycloak.forms.login.LoginFormsProvider.class)
          .setError("emailVerificationCancelled").createErrorPage(Response.Status.BAD_REQUEST);
    }
    return super.handleToken(token, context);
  }
}
