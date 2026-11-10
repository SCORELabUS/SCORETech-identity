package es.tentuplaza.identity.emailotp;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.keycloak.models.*;
class IdentityLinksTest {
  final KeycloakSession session=mock(KeycloakSession.class,RETURNS_DEEP_STUBS);
  final RealmModel realm=mock(RealmModel.class);
  final UserModel user=mock(UserModel.class,RETURNS_DEEP_STUBS);
  IdentityLinksTest() { when(session.users().getFederatedIdentitiesStream(realm,user)).thenAnswer(i->Stream.empty()); }
  @Test void lastUnverifiedMailboxIdentityCannotBeDisconnected() {
    when(user.getEmail()).thenReturn("unverified@example.invalid");
    assertFalse(IdentityLinks.canDisconnect(session,realm,user,"us-sso"));
  }
  @Test void verifiedMailboxOrLocalCredentialProvidesFallback() {
    when(user.getEmail()).thenReturn("verified@example.invalid");when(user.isEmailVerified()).thenReturn(true);
    assertTrue(IdentityLinks.canDisconnect(session,realm,user,"google"));
    when(user.isEmailVerified()).thenReturn(false);when(user.credentialManager().isConfiguredFor("otp")).thenReturn(true);
    assertTrue(IdentityLinks.canDisconnect(session,realm,user,"google"));
  }
  @Test void unverifiedMailboxAndPasskeyCannotBypassRequiredLocalEmailVerification() {
    when(realm.isVerifyEmail()).thenReturn(true);
    when(user.credentialManager().isConfiguredFor(AuthenticationPolicy.PASSKEY)).thenReturn(true);
    assertFalse(IdentityLinks.canDisconnect(session,realm,user,"us-sso"));
    when(realm.isVerifyEmail()).thenReturn(false);
    assertTrue(IdentityLinks.canDisconnect(session,realm,user,"us-sso"));
  }
  @Test void disabledOrLinkOnlyProviderDoesNotCountAsFallback() {
    var linked=new FederatedIdentityModel("google","external-id","external-name");
    var provider=new IdentityProviderModel();provider.setAlias("google");provider.setEnabled(false);
    when(session.users().getFederatedIdentitiesStream(realm,user)).thenAnswer(i->Stream.of(linked));
    when(session.identityProviders().getByAlias("google")).thenReturn(provider);
    assertFalse(IdentityLinks.canDisconnect(session,realm,user,"us-sso"));
    provider.setEnabled(true);assertTrue(IdentityLinks.canDisconnect(session,realm,user,"us-sso"));
    provider.setLinkOnly(true);assertFalse(IdentityLinks.canDisconnect(session,realm,user,"us-sso"));
  }
  @Test void listingNeverReturnsTokensAndIncludesUnavailableLinkedProviders() {
    var link=new FederatedIdentityModel("google","external-id","me@example.invalid","secret-never-return");
    when(session.users().getFederatedIdentity(realm,user,"google")).thenReturn(link);
    var values=IdentityLinks.list(session,realm,user);
    assertEquals(2,values.size());assertEquals("me@example.invalid",values.get(0).get("externalUsername"));
    assertEquals(false,values.get(0).get("enabled"));assertEquals(true,values.get(0).get("linked"));
    assertFalse(values.toString().contains("secret-never-return"));
  }
  @Test void administratorWithoutPasskeyCannotRemoveIdentityEvenWithVerifiedEmail() {
    var role=mock(RoleModel.class);when(realm.getRole("administrador")).thenReturn(role);when(user.hasRole(role)).thenReturn(true);
    when(user.isEmailVerified()).thenReturn(true);when(user.getEmail()).thenReturn("admin@example.invalid");
    assertFalse(IdentityLinks.canDisconnect(session,realm,user,"google"));
  }
}
