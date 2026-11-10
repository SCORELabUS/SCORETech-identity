package es.tentuplaza.identity.emailotp;

import org.keycloak.authentication.RequiredActionContext;
import org.keycloak.authentication.requiredactions.VerifyEmail;

/** Preserve native mailbox verification except within an authenticated broker transaction. */
public final class BrokerAwareVerifyEmail extends VerifyEmail {
  @Override public int order() { return 10; }
  static boolean authenticatedBroker(RequiredActionContext context) {
    var auth = context.getAuthenticationSession();
    var user = context.getUser();
    return auth != null && user != null && user.getId() != null && user.isEnabled()
        && user.getId().equals(auth.getAuthNote(BrokerLoginGuard.AUTHENTICATED_USER))
        && !"VERIFY_EMAIL".equals(auth.getClientNote("kc_action"));
  }
  @Override public void evaluateTriggers(RequiredActionContext context) {
    if (!authenticatedBroker(context)) super.evaluateTriggers(context);
  }
  @Override public void requiredActionChallenge(RequiredActionContext context) {
    // Also handles VERIFY_EMAIL left pending by an earlier version of the broker.
    if (authenticatedBroker(context)) context.success();
    else super.requiredActionChallenge(context);
  }
}
