package es.tentuplaza.identity.emailotp;
import org.keycloak.authentication.*;
import jakarta.ws.rs.core.Response;
final class InvitationRegistration {
  static boolean bind(AuthenticationFlowContext context) {
    var auth=context.getAuthenticationSession();
    String ticket=context.getUriInfo().getQueryParameters().getFirst("invitation_ticket");
    if(ticket==null || auth.getAuthNote(InvitationStore.NOTE)!=null) return false;
    var data=context.getSession().singleUseObjects().remove("tentu-invitation-ticket:"+InvitationStore.hash(ticket));
    if(data==null || !context.getRealm().getId().equals(data.get("realm")) || !auth.getClient().getClientId().equals(data.get("client"))) {
      context.failureChallenge(AuthenticationFlowError.INVALID_USER,context.form().setError("tentuInvitationUnavailable").createErrorPage(Response.Status.GONE)); return true;
    }
    var store=new InvitationStore(context.getSession());
    try { store.available(store.get(data.get("invitation"),false)); }
    catch(jakarta.ws.rs.ClientErrorException error) { context.failureChallenge(AuthenticationFlowError.INVALID_USER,context.form().setError("tentuInvitationUnavailable").createErrorPage(Response.Status.CONFLICT)); return true; }
    auth.setAuthNote(InvitationStore.NOTE,data.get("invitation")); return false;
  }
}
