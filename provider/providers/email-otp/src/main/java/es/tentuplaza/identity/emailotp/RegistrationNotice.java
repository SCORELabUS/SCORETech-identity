package es.tentuplaza.identity.emailotp;

import org.keycloak.authentication.AuthenticationFlowContext;

/** Optional presentation context, scoped to one authentication transaction. */
final class RegistrationNotice {
  static final String PARAMETER = "registration_notice";
  static final String CONFIDENTIALITY = "confidentiality";
  private static final String NOTE = "tentu.registration.notice";

  private RegistrationNotice() { }

  static void capture(AuthenticationFlowContext context) {
    var auth = context.getAuthenticationSession();
    if (auth.getAuthNote(NOTE) != null) return;
    var values = context.getUriInfo().getQueryParameters().get(PARAMETER);
    boolean requested = values != null && values.size() == 1
        && CONFIDENTIALITY.equals(values.get(0));
    auth.setAuthNote(NOTE, requested ? CONFIDENTIALITY : "none");
  }

  static boolean enabled(AuthenticationFlowContext context) {
    return CONFIDENTIALITY.equals(context.getAuthenticationSession().getAuthNote(NOTE));
  }
}
