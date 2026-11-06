package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;
import com.webauthn4j.WebAuthnAuthenticationManager;
import com.webauthn4j.data.client.Origin;
import com.webauthn4j.data.client.challenge.DefaultChallenge;
import com.webauthn4j.server.ServerProperty;
import org.junit.jupiter.api.Test;
import org.keycloak.credential.*;
import org.keycloak.models.*;
import org.keycloak.sessions.AuthenticationSessionModel;

class StepUpPasskeyFactoryTest {
  @Test void cachedProviderUsesCurrentTicketAndKeepsNormalLoginRestrictions() throws Exception {
    var session = mock(KeycloakSession.class, RETURNS_DEEP_STUBS);
    var realm = mock(RealmModel.class, RETURNS_DEEP_STUBS);
    when(session.getContext().getRealm()).thenReturn(realm);
    when(realm.getWebAuthnPolicyPasswordless().getExtraOrigins()).thenReturn(List.of());
    when(session.getContext().getAuthenticationSession()).thenReturn(null);
    var provider = new StepUpPasskeyFactory().create(session);
    var managerMethod = provider.getClass().getDeclaredMethod("getWebAuthnAuthenticationManager");
    managerMethod.setAccessible(true);
    var nativeProvider = new WebAuthnPasswordlessCredentialProviderFactory().create(session);
    var nativeMethod = WebAuthnCredentialProvider.class.getDeclaredMethod("getWebAuthnAuthenticationManager");
    nativeMethod.setAccessible(true);
    var nativeCrossOrigin = ((WebAuthnAuthenticationManager) nativeMethod.invoke(nativeProvider)).getAuthenticationDataVerifier().isCrossOriginAllowed();
    assertEquals(nativeCrossOrigin, ((WebAuthnAuthenticationManager) managerMethod.invoke(provider)).getAuthenticationDataVerifier().isCrossOriginAllowed());

    var auth = mock(AuthenticationSessionModel.class);
    when(session.getContext().getAuthenticationSession()).thenReturn(auth);
    when(auth.getAuthNote(StepUpResourceFactory.NOTE)).thenReturn("user:target:credentials");
    when(auth.getAuthNote("tentu.step-up.origin")).thenReturn("https://admin.example.test");
    when(auth.getAuthNote("tentu.step-up.user")).thenReturn("actor");
    when(auth.getAuthNote("tentu.step-up.session")).thenReturn("original");
    when(auth.getAuthNote("tentu.step-up.expires")).thenReturn(Long.toString(Instant.now().plusSeconds(120).toEpochMilli()));
    when(session.sessions().getUserSession(realm, "original")).thenReturn(mock(UserSessionModel.class));
    assertTrue(((WebAuthnAuthenticationManager) managerMethod.invoke(provider)).getAuthenticationDataVerifier().isCrossOriginAllowed());

    var user = mock(UserModel.class, RETURNS_DEEP_STUBS);
    when(user.isEnabled()).thenReturn(true); when(user.getId()).thenReturn("actor");
    when(user.credentialManager().getStoredCredentialsByTypeStream(AuthenticationPolicy.PASSKEY)).thenReturn(Stream.empty());
    var original = ServerProperty.builder().origins(Set.of(new Origin("https://identity.example.test")))
      .rpId("identity.example.test").challenge(new DefaultChallenge()).build();
    var assertion = new WebAuthnCredentialModelInput(AuthenticationPolicy.PASSKEY);
    assertion.setAuthenticationParameters(new WebAuthnCredentialModelInput.KeycloakWebAuthnAuthenticationParameters(original, false));
    assertFalse(((CredentialInputValidator) provider).isValid(realm, user, assertion)); // no credential fixture
    var checked = assertion.getAuthenticationParameters();
    assertEquals(original.getRpId(), checked.getServerProperty().getRpId());
    assertEquals(original.getChallenge(), checked.getServerProperty().getChallenge());
    assertSame(original.getOriginPredicate(), checked.getServerProperty().getOriginPredicate());
    assertTrue(checked.getServerProperty().getOriginPredicate().test(new Origin("https://identity.example.test")));
    assertFalse(checked.getServerProperty().getOriginPredicate().test(new Origin("https://evil.example.test")));
    assertTrue(checked.getServerProperty().getTopOriginPredicate().test(new Origin("https://admin.example.test")));
    assertFalse(checked.getServerProperty().getTopOriginPredicate().test(new Origin("https://evil.example.test")));
    assertTrue(checked.isUserVerificationRequired());

    when(auth.getAuthNote("tentu.step-up.expires")).thenReturn("1");
    assertFalse(((CredentialInputValidator) provider).isValid(realm, user, assertion));
    when(auth.getAuthNote(StepUpResourceFactory.NOTE)).thenReturn(null);
    assertEquals(nativeCrossOrigin, ((WebAuthnAuthenticationManager) managerMethod.invoke(provider)).getAuthenticationDataVerifier().isCrossOriginAllowed());
  }
}
