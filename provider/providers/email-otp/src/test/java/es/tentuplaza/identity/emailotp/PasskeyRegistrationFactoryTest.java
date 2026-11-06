package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import org.junit.jupiter.api.Test;
import org.keycloak.authentication.RequiredActionFactory;
import org.keycloak.authentication.RequiredActionProvider;
import org.keycloak.common.util.Time;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.UserSessionModel;
import org.keycloak.protocol.oidc.OIDCLoginProtocol;
import org.keycloak.services.managers.AuthenticationManager;
import org.keycloak.sessions.AuthenticationSessionModel;

class PasskeyRegistrationFactoryTest {
  @Test void nativeProtocolEnforcesRecentAuthenticationEvenWithoutClientMaxAge() {
    var session = mock(KeycloakSession.class, RETURNS_DEEP_STUBS);
    var nativeFactory = mock(RequiredActionFactory.class);
    var sessionFactory = session.getKeycloakSessionFactory();
    doReturn(nativeFactory).when(sessionFactory).getProviderFactory(
        RequiredActionProvider.class, "webauthn-register-passwordless");
    when(nativeFactory.create(session)).thenReturn(mock(RequiredActionProvider.class));
    var action = new PasskeyRegistrationFactory().create(session);
    assertEquals(300, action.getMaxAuthAge(session));
    doReturn(action).when(session).getProvider(RequiredActionProvider.class, AuthenticationPolicy.REGISTER);
    var protocol = new OIDCLoginProtocol(session, null, null, null, null);
    var auth = mock(AuthenticationSessionModel.class);
    when(auth.getClientNote("kc_action")).thenReturn(AuthenticationPolicy.REGISTER);
    var userSession = mock(UserSessionModel.class);
    // No browser max_age: Identity must still enforce its own window.
    for (int age : new int[]{0, 30, 299}) {
      when(userSession.getNote(AuthenticationManager.AUTH_TIME)).thenReturn(Integer.toString(Time.currentTime() - age));
      assertFalse(protocol.requireReauthentication(userSession, auth), "recent authentication: " + age);
    }
    when(userSession.getNote(AuthenticationManager.AUTH_TIME)).thenReturn(Integer.toString(Time.currentTime() - 301));
    assertTrue(protocol.requireReauthentication(userSession, auth));
    when(userSession.getNote(AuthenticationManager.AUTH_TIME)).thenReturn(null);
    assertTrue(protocol.requireReauthentication(userSession, auth));
    when(userSession.getNote(AuthenticationManager.AUTH_TIME)).thenReturn(Integer.toString(Time.currentTime()));
    when(auth.getClientNote("prompt")).thenReturn("login");
    assertTrue(protocol.requireReauthentication(userSession, auth));
  }
}
