package es.tentuplaza.identity.emailotp;

import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.keycloak.models.*;
import org.keycloak.representations.AccessToken;
import org.keycloak.representations.IDToken;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

final class AuthenticationPolicyMapperTest {
  private static final class Fixture {
    final AuthenticationPolicyMapper mapper = new AuthenticationPolicyMapper();
    final UserModel user = mock(UserModel.class);
    final UserSessionModel session = mock(UserSessionModel.class);
    final ClientSessionContext context = mock(ClientSessionContext.class);
    final ClientModel client = mock(ClientModel.class);
    Fixture() {
      var clientSession = mock(AuthenticatedClientSessionModel.class);
      when(session.getUser()).thenReturn(user);
      when(session.getRealm()).thenReturn(mock(RealmModel.class));
      when(context.getClientSession()).thenReturn(clientSession);
      when(clientSession.getClient()).thenReturn(client);
      when(client.getClientId()).thenReturn("space");
      var profile = mock(ClientScopeModel.class);
      var email = mock(ClientScopeModel.class);
      when(profile.getName()).thenReturn("profile");
      when(email.getName()).thenReturn("email");
      when(context.getClientScopesStream()).thenAnswer(call -> Stream.of(profile, email));
      when(user.getEmail()).thenReturn("case@example.invalid");
      when(user.isEmailVerified()).thenReturn(true);
      when(user.getUsername()).thenReturn("case@example.invalid");
      when(user.getFirstName()).thenReturn("First");
      when(user.getLastName()).thenReturn("Last");
      when(user.getFirstAttribute("scoreProfile")).thenReturn(
          """
          {"displayName":"  Sample User  ","dateOfBirth":"2000-01-01","city":"Seville","country":"Spain",
           "bio":"Sample bio","private":"must not be emitted"}
          """);
      when(user.getFirstAttribute("scoreSocialLinks")).thenReturn(
          """
          {"linkedin":"https://linkedin.com/in/example","x":"https://x.com/hidden",
           "facebook":"https://example.invalid/private"}
          """);
      when(user.getFirstAttribute("tentuAvatar")).thenReturn(
          """
          {"kind":"photo","imageKey":"avatars/private/photo.jpg"}
          """);
    }
    IDToken idToken(IDToken token) { return mapper.transformIDToken(token, null, null, session, context); }
    AccessToken accessToken(AccessToken token) { return mapper.transformAccessToken(token, null, null, session, context); }
  }

  @Test
  void keepsLegacyClientsCompatibleWithoutAnExplicitPolicy() {
    var f = new Fixture();
    var original = new IDToken();
    original.setEmail("native@example.invalid");
    assertEquals("native@example.invalid", f.idToken(original).getEmail());
    assertFalse(original.getOtherClaims().containsKey("scoretech_display_name"));

    when(f.client.getAttribute(ApplicationUserClaims.LEGACY_DISPLAY_NAME)).thenReturn("true");
    assertEquals("Sample User", f.idToken(new IDToken()).getOtherClaims().get("scoretech_display_name"));
    assertFalse(f.accessToken(new AccessToken()).getOtherClaims().containsKey("scoretech_display_name"));
  }

  @Test
  void projectsIndividualValuesAndStripsUnselectedNativeAndCustomClaims() {
    var f = new Fixture();
    when(f.client.getAttribute(ApplicationUserClaims.ATTRIBUTE)).thenReturn(
        """
        ["preferred_username","given_name","display_name","city","linkedin","facebook","avatar"]
        """);
    var initial = new IDToken();
    initial.subject("stable-subject");
    initial.setEmail("native@example.invalid");
    initial.setEmailVerified(true);
    initial.setFamilyName("hidden");
    initial.setBirthdate("2000-01-01");
    initial.getOtherClaims().put("unknown_raw_attribute", "private");
    var id = f.idToken(initial);
    assertEquals("stable-subject", id.getSubject());
    assertEquals("First", id.getGivenName());
    assertEquals("case", id.getPreferredUsername());
    assertEquals("Sample User", id.getOtherClaims().get("scoretech_display_name"));
    assertEquals("Seville", id.getOtherClaims().get("scoretech_city"));
    assertEquals(Map.of("linkedin", "https://linkedin.com/in/example"), id.getOtherClaims().get("scoretech_social_links"));
    assertNull(id.getEmail());
    assertNull(id.getEmailVerified());
    assertNull(id.getFamilyName());
    assertNull(id.getBirthdate());
    assertFalse(id.getOtherClaims().containsKey("scoretech_country"));
    assertFalse(id.getOtherClaims().containsKey("scoretech_avatar"));
    assertFalse(id.getOtherClaims().containsKey("unknown_raw_attribute"));

    var userInfo = new AccessToken();
    userInfo.setEmail("native@example.invalid");
    f.mapper.transformUserInfoToken(userInfo, null, null, f.session, f.context);
    assertEquals("First", userInfo.getGivenName());
    assertNull(userInfo.getEmail());

    var access = new AccessToken();
    access.setGivenName("native name");
    access.setRealmAccess(new AccessToken.Access().addRole("space:access"));
    f.accessToken(access);
    assertNull(access.getGivenName());
    assertTrue(access.getRealmAccess().isUserInRole("space:access"));
    var introspection = new AccessToken();
    introspection.setPreferredUsername("native username");
    f.mapper.transformIntrospectionToken(introspection, null, null, f.session, f.context);
    assertNull(introspection.getPreferredUsername());
  }

  @Test
  void keepsEmailAndVerificationTogetherAndFailsClosedOnBadOrEmptyPolicies() {
    var f = new Fixture();
    when(f.client.getAttribute(ApplicationUserClaims.ATTRIBUTE)).thenReturn("[\"email\"]", "[\"password\"]", "[]");
    var id = f.idToken(new IDToken());
    assertEquals("case@example.invalid", id.getEmail());
    assertEquals(true, id.getEmailVerified());
    assertNull(id.getPreferredUsername());
    for (int repeat = 0; repeat < 2; repeat++) {
      var previous = new IDToken();
      previous.setEmail("from-native-mapper@example.invalid");
      assertNull(f.idToken(previous).getEmail());
    }
  }
}
