package es.tentuplaza.identity.emailotp;
import static org.mockito.Mockito.*;
import static org.junit.jupiter.api.Assertions.*;
import jakarta.ws.rs.core.MultivaluedHashMap;
import org.junit.jupiter.api.Test;
import org.keycloak.authentication.*;
import org.keycloak.models.*;

class AccountDeletionTest {
  final KeycloakSession session = mock(KeycloakSession.class, RETURNS_DEEP_STUBS);
  final RequiredActionContext context = mock(RequiredActionContext.class, RETURNS_DEEP_STUBS);
  final RealmModel realm = mock(RealmModel.class);
  final UserModel user = mock(UserModel.class);
  final MultivaluedHashMap<String, String> form = new MultivaluedHashMap<>();
  final RequiredActionProvider action = new AccountDeletionFactory().create(session);
  AccountDeletionTest() {
    when(context.getSession()).thenReturn(session); when(context.getRealm()).thenReturn(realm); when(context.getUser()).thenReturn(user);
    when(user.getId()).thenReturn("user"); when(user.isEnabled()).thenReturn(true); when(user.getEmail()).thenReturn("me@example.invalid");
    when(context.getAuthenticationSession().getAuthenticatedUser()).thenReturn(user);
    when(context.getAuthenticationSession().getClient().getClientId()).thenReturn("identity-account-web");
    when(context.getHttpRequest().getDecodedFormParameters()).thenReturn(form);
  }
  @Test void requiresFreshNativeAuthentication() { assertEquals(0, action.getMaxAuthAge(session)); }
  @Test void cancellingNeverDeletesAnything() { form.putSingle("decision", "cancel"); action.processAction(context); verify(context).success(); verify(session, never()).users(); }
  @Test void challengeNeedsCorrectClientAndSameUser() {
    when(context.getAuthenticationSession().getClient().getClientId()).thenReturn("untrusted"); action.requiredActionChallenge(context);
    verify(context.form().setError(anyString())).createErrorPage(any()); verify(session, never()).users();
  }
  @Test void differentNativeUserCannotBeDeleted() {
    when(context.getAuthenticationSession().getAuthenticatedUser()).thenReturn(mock(UserModel.class));
    form.putSingle("decision", "delete"); form.putSingle("confirmation", "me@example.invalid"); action.processAction(context);
    verify(context.form().setError(anyString())).createErrorPage(any()); verify(session, never()).users();
  }
  @Test void protectsAdminEvenWithCorrectConfirmation() {
    var admin = mock(RoleModel.class); when(realm.getRole("administrador")).thenReturn(admin); when(user.hasRole(admin)).thenReturn(true);
    form.putSingle("decision", "delete"); form.putSingle("confirmation", "me@example.invalid"); action.processAction(context);
    verify(context.form().setError(anyString())).createErrorPage(any()); verify(session, never()).users();
  }
  @Test void missingOrWrongTypedConfirmationDoesNotDelete() {
    form.putSingle("decision", "delete"); form.putSingle("confirmation", "other@example.invalid"); action.processAction(context);
    verify(context.form()).setError(eq("Type your email address to confirm deletion.")); verify(session, never()).users();
  }
}
