package es.tentuplaza.identity.emailotp;

import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.keycloak.models.*;
import org.keycloak.representations.AccessToken;
import org.keycloak.representations.IDToken;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

final class AuthenticationPolicyMapperTest {
  @Test
  void sharesOnlyTheCurrentDisplayNameInOptedInProfileIdTokens() {
    var mapper = new AuthenticationPolicyMapper();
    var user = mock(UserModel.class);
    var realm = mock(RealmModel.class);
    var session = mock(UserSessionModel.class);
    var context = mock(ClientSessionContext.class);
    var clientSession = mock(AuthenticatedClientSessionModel.class);
    var client = mock(ClientModel.class);
    var profileScope = mock(ClientScopeModel.class);
    when(session.getUser()).thenReturn(user);
    when(session.getRealm()).thenReturn(realm);
    when(context.getClientSession()).thenReturn(clientSession);
    when(clientSession.getClient()).thenReturn(client);
    when(client.getClientId()).thenReturn("space");
    when(profileScope.getName()).thenReturn("profile");
    when(context.getClientScopesStream()).thenAnswer(call -> Stream.of(profileScope));
    when(user.getFirstAttribute("scoreProfile")).thenReturn(
        "{\"displayName\":\"  Sample User  \",\"dateOfBirth\":\"2000-01-01\"}");

    assertFalse(mapper.transformIDToken(new IDToken(), null, null, session, context)
        .getOtherClaims().containsKey("scoretech_display_name"));

    when(client.getAttribute("scoretech.shared-display-name")).thenReturn("true");
    var token = mapper.transformIDToken(new IDToken(), null, null, session, context);
    assertEquals("Sample User", token.getOtherClaims().get("scoretech_display_name"));
    assertFalse(token.getOtherClaims().containsValue("2000-01-01"));
    assertFalse(mapper.transformAccessToken(new AccessToken(), null, null, session, context)
        .getOtherClaims().containsKey("scoretech_display_name"));

    when(user.getFirstAttribute("scoreProfile")).thenReturn("{}");
    assertEquals("", mapper.transformIDToken(new IDToken(), null, null, session, context)
        .getOtherClaims().get("scoretech_display_name"));
    when(context.getClientScopesStream()).thenAnswer(call -> Stream.empty());
    assertFalse(mapper.transformIDToken(new IDToken(), null, null, session, context)
        .getOtherClaims().containsKey("scoretech_display_name"));
  }
}
