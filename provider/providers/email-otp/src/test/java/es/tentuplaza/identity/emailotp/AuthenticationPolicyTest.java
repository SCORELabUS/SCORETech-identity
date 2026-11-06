package es.tentuplaza.identity.emailotp;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import org.junit.jupiter.api.Test;
import org.keycloak.models.*;
import org.keycloak.representations.AccessToken;
class AuthenticationPolicyTest {
  @Test void issuanceAndRefreshRejectWeakSessionsAndRemovedPasskeys() {
    var mapper=new AuthenticationPolicyMapper(); var session=mock(KeycloakSession.class); var us=mock(UserSessionModel.class); var realm=mock(RealmModel.class); var user=mock(UserModel.class,RETURNS_DEEP_STUBS); var role=mock(RoleModel.class);
    when(us.getUser()).thenReturn(user); when(us.getRealm()).thenReturn(realm); when(realm.getRole("administrador")).thenReturn(role); when(user.hasRole(role)).thenReturn(true); when(user.credentialManager().isConfiguredFor(AuthenticationPolicy.PASSKEY)).thenReturn(true);
    var model=new ProtocolMapperModel(); model.setConfig(java.util.Map.of("access.token.claim","true","id.token.claim","true"));
    assertThrows(jakarta.ws.rs.ForbiddenException.class,()->mapper.transformAccessToken(new AccessToken(),model,session,us,null));
    when(us.getNote(AuthenticationPolicy.METHOD)).thenReturn(AuthenticationPolicy.PASSKEY);
    assertThrows(jakarta.ws.rs.ForbiddenException.class,()->mapper.transformAccessToken(new AccessToken(),model,session,us,null));
    when(us.getNote(AuthenticationPolicy.ADMIN)).thenReturn("true");
    assertEquals(true,mapper.transformAccessToken(new AccessToken(),model,session,us,null).getOtherClaims().get("tentu_admin_verified"));
    when(user.credentialManager().isConfiguredFor(AuthenticationPolicy.PASSKEY)).thenReturn(false);
    assertThrows(jakarta.ws.rs.ForbiddenException.class,()->mapper.transformAccessToken(new AccessToken(),model,session,us,null));
  }
  @Test void delegatedAdminWithoutGlobalAdministratorRoleRequiresPasskey() {
    var realm = mock(RealmModel.class); var user = mock(UserModel.class, RETURNS_DEEP_STUBS);
    var access = mock(RoleModel.class);
    when(realm.getRole("administrador")).thenReturn(null);
    when(realm.getRole("admin-web:local:access")).thenReturn(access);
    when(user.hasRole(access)).thenReturn(true);
    assertTrue(AuthenticationPolicy.isAdmin(realm, user));
    var mapper = new AuthenticationPolicyMapper(); var session = mock(KeycloakSession.class);
    var userSession = mock(UserSessionModel.class); var model = new ProtocolMapperModel();
    when(userSession.getUser()).thenReturn(user); when(userSession.getRealm()).thenReturn(realm);
    when(userSession.getNote(AuthenticationPolicy.METHOD)).thenReturn("email-otp");
    when(userSession.getNote(AuthenticationPolicy.ADMIN)).thenReturn("false");
    when(user.credentialManager().isConfiguredFor(AuthenticationPolicy.PASSKEY)).thenReturn(true);
    assertThrows(jakarta.ws.rs.ForbiddenException.class,
        () -> mapper.transformAccessToken(new AccessToken(), model, session, userSession, null));
    when(userSession.getNote(AuthenticationPolicy.METHOD)).thenReturn(AuthenticationPolicy.PASSKEY);
    when(userSession.getNote(AuthenticationPolicy.ADMIN)).thenReturn("true");
    assertEquals(true, mapper.transformAccessToken(new AccessToken(), model, session, userSession, null)
        .getOtherClaims().get("tentu_admin_verified"));
  }
  @Test void refreshingExistingSessionRechecksDelegatedAccessAndCurrentPasskey() {
    var mapper = new AuthenticationPolicyMapper(); var session = mock(KeycloakSession.class);
    var userSession = mock(UserSessionModel.class); var realm = mock(RealmModel.class);
    var user = mock(UserModel.class, RETURNS_DEEP_STUBS); var access = mock(RoleModel.class);
    var model = new ProtocolMapperModel();
    when(userSession.getUser()).thenReturn(user); when(userSession.getRealm()).thenReturn(realm);
    when(realm.getRole("admin-web:local:access")).thenReturn(access);
    when(userSession.getNote(AuthenticationPolicy.METHOD)).thenReturn("email-otp");
    when(userSession.getNote(AuthenticationPolicy.ADMIN)).thenReturn("false");
    assertEquals(false, mapper.transformAccessToken(new AccessToken(), model, session, userSession, null)
        .getOtherClaims().get("tentu_admin_verified"));
    // Refresh invokes this mapper with the same session and current effective roles.
    when(user.hasRole(access)).thenReturn(true);
    assertThrows(jakarta.ws.rs.ForbiddenException.class,
        () -> mapper.transformAccessToken(new AccessToken(), model, session, userSession, null));
    when(userSession.getNote(AuthenticationPolicy.METHOD)).thenReturn(AuthenticationPolicy.PASSKEY);
    when(userSession.getNote(AuthenticationPolicy.ADMIN)).thenReturn("true");
    when(user.credentialManager().isConfiguredFor(AuthenticationPolicy.PASSKEY)).thenReturn(true);
    assertEquals(true, mapper.transformAccessToken(new AccessToken(), model, session, userSession, null)
        .getOtherClaims().get("tentu_admin_verified"));
    when(user.credentialManager().isConfiguredFor(AuthenticationPolicy.PASSKEY)).thenReturn(false);
    assertThrows(jakarta.ws.rs.ForbiddenException.class,
        () -> mapper.transformAccessToken(new AccessToken(), model, session, userSession, null));
  }
  @Test void parsesCustomTemplatesWithTheBundledFreemarkerEngine() throws Exception {
    var c=new freemarker.template.Configuration(freemarker.template.Configuration.VERSION_2_3_32); var root=java.nio.file.Path.of("../../themes/score").toAbsolutePath().normalize(); c.setOutputFormat(freemarker.core.HTMLOutputFormat.INSTANCE); c.setDirectoryForTemplateLoading(root.toFile());
    try(var files=java.nio.file.Files.walk(root)) { for(var p:files.filter(p->p.toString().endsWith(".ftl")).toList()) c.getTemplate(root.relativize(p).toString()); }
  }
}
