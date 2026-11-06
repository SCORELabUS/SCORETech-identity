package es.tentuplaza.identity.emailotp;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import org.junit.jupiter.api.Test;
import org.keycloak.authentication.actiontoken.ActionTokenContext;
import org.keycloak.authentication.actiontoken.updateemail.UpdateEmailActionToken;
import org.keycloak.models.*;
import org.keycloak.forms.login.LoginFormsProvider;
import java.util.Map;
class EmailChangeTokenTest {
  @SuppressWarnings("unchecked")
  @Test void oldRequestIsRejectedWithoutRemovingTheCurrentRequest() {
    var context=(ActionTokenContext<UpdateEmailActionToken>)mock(ActionTokenContext.class,RETURNS_DEEP_STUBS);
    when(context.getRealm().getId()).thenReturn("realm");
    var token=new UpdateEmailActionToken("user",Integer.MAX_VALUE,"old@example.invalid","new@example.invalid","fixture");
    var session=context.getSession();
    when(session.singleUseObjects().get("tentu-email-latest:realm:user")).thenReturn(Map.of("nonce","newer-request"));
    var form=mock(LoginFormsProvider.class,RETURNS_SELF);doReturn(form).when(session).getProvider(LoginFormsProvider.class);
    new LatestUpdateEmailTokenHandler().handleToken(token,context);
    verify(form).setError(eq("emailVerificationCancelled"));
    verify(session.singleUseObjects(),never()).remove(anyString());
    verify(session.singleUseObjects(),never()).put(anyString(),anyLong(),anyMap());
  }
  @Test void cancellingPendingEmailKeepsTheEffectiveAddressAndInvalidatesTheRequest() {
    var context=mock(org.keycloak.authentication.RequiredActionContext.class,RETURNS_DEEP_STUBS);
    when(context.getRealm().getId()).thenReturn("realm");
    when(context.getUser().getId()).thenReturn("user");
    var form=new jakarta.ws.rs.core.MultivaluedHashMap<String,String>();
    form.putSingle("tentu-cancel-pending","true");
    when(context.getHttpRequest().getDecodedFormParameters()).thenReturn(form);
    new LatestUpdateEmail().processAction(context);
    verify(context.getSession().singleUseObjects()).remove("tentu-email-latest:realm:user");
    verify(context.getUser()).removeAttribute(UserModel.EMAIL_PENDING);
    verify(context.getUser(),never()).setEmail(anyString());
    verify(context).success();
  }

}
