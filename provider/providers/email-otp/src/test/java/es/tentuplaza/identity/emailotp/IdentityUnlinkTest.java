package es.tentuplaza.identity.emailotp;
import static org.mockito.Mockito.*;
import static org.junit.jupiter.api.Assertions.*;
import java.util.stream.Stream;
import jakarta.ws.rs.core.MultivaluedHashMap;
import org.junit.jupiter.api.Test;
import org.keycloak.authentication.*;
import org.keycloak.models.*;
class IdentityUnlinkTest {
 final KeycloakSession session=mock(KeycloakSession.class,RETURNS_DEEP_STUBS);
 final RequiredActionContext context=mock(RequiredActionContext.class,RETURNS_DEEP_STUBS);
 final RealmModel realm=mock(RealmModel.class);
 final UserModel user=mock(UserModel.class,RETURNS_DEEP_STUBS);
 final MultivaluedHashMap<String,String> form=new MultivaluedHashMap<>();
 final RequiredActionProvider action=new IdentityUnlinkFactory().create(session);
 IdentityUnlinkTest() {
  when(context.getSession()).thenReturn(session);when(context.getRealm()).thenReturn(realm);when(context.getUser()).thenReturn(user);
  when(user.getId()).thenReturn("user");when(realm.getId()).thenReturn("realm");when(user.isEnabled()).thenReturn(true);
  when(user.isEmailVerified()).thenReturn(true);when(user.getEmail()).thenReturn("me@example.invalid");
  when(context.getAuthenticationSession().getClient().getClientId()).thenReturn("identity-account-web");
  when(context.getAuthenticationSession().getClientNote(Constants.KC_ACTION_PARAMETER)).thenReturn("google");
  when(context.getHttpRequest().getDecodedFormParameters()).thenReturn(form);
  when(session.users().getFederatedIdentity(realm,user,"google")).thenReturn(new FederatedIdentityModel("google","external","me"));
  when(session.users().getFederatedIdentitiesStream(realm,user)).thenAnswer(i->Stream.empty());
  when(session.singleUseObjects().putIfAbsent(anyString(),anyLong())).thenReturn(true);
  when(session.users().removeFederatedIdentity(realm,user,"google")).thenReturn(true);
 }
 @Test void cancellationNeverRemovesIdentity() {form.putSingle("decision","cancel");action.processAction(context);verify(context).success();verify(session.users(),never()).removeFederatedIdentity(any(),any(),any());}
 @Test void confirmedRemovalIsLockedAndTargetsOnlyAuthenticatedUser() {form.putSingle("decision","disconnect");action.processAction(context);verify(session.singleUseObjects()).putIfAbsent("tentu-credential-mutation:realm:user",900);verify(session.users()).removeFederatedIdentity(realm,user,"google");verify(context).success();}
 @Test void missingFallbackOrWrongClientCannotRemoveIdentity() {form.putSingle("decision","disconnect");when(user.isEmailVerified()).thenReturn(false);action.processAction(context);verify(session.users(),never()).removeFederatedIdentity(any(),any(),any());}
 @Test void wrongClientCannotRemoveIdentity() {form.putSingle("decision","disconnect");when(context.getAuthenticationSession().getClient().getClientId()).thenReturn("untrusted-client");action.processAction(context);verify(session.users(),never()).removeFederatedIdentity(any(),any(),any());}
 @Test void requiresImmediateNativeReauthentication() {assertEquals(0,action.getMaxAuthAge(session));}
}
