package es.tentuplaza.identity.emailotp;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import java.util.stream.Stream;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.keycloak.models.*;
import org.keycloak.credential.CredentialModel;
import org.keycloak.email.*;
import jakarta.ws.rs.*;

class SupportResourceTest {
  final KeycloakSession session = mock(KeycloakSession.class, RETURNS_DEEP_STUBS);
  final RealmModel realm = mock(RealmModel.class);
  final UserModel user = mock(UserModel.class, RETURNS_DEEP_STUBS);
  CredentialModel credential(String id, String type) { var c = new CredentialModel(); c.setId(id); c.setType(type); return c; }
  void methods(CredentialModel... items) {
    when(user.credentialManager().getStoredCredentialsStream()).thenAnswer(i -> Stream.of(items));
    when(user.credentialManager().getStoredCredentialById("remove")).thenReturn(items[0]);
    when(user.credentialManager().removeStoredCredentialById("remove")).thenReturn(true);
  }
  @Test void blocksForeignIdsAndTheLastUsableMethod() {
    when(user.credentialManager().getStoredCredentialById("foreign")).thenReturn(null);
    assertThrows(NotFoundException.class, () -> SupportResourceFactory.removeCredential(session, realm, user, "foreign"));
    methods(credential("remove", "otp"));
    when(user.getEmail()).thenReturn("verified@example.invalid"); when(user.isEmailVerified()).thenReturn(true);
    assertThrows(ClientErrorException.class, () -> SupportResourceFactory.removeCredential(session, realm, user, "remove"));
    verify(user.credentialManager(), never()).removeStoredCredentialById(any());
  }
  @Test void effectiveAdministrativeRoleProtectsLastPasskeyEvenWhenTotpRemains() {
    var role = mock(RoleModel.class); when(realm.getRole("administrador")).thenReturn(role); when(user.hasRole(role)).thenReturn(true);
    methods(credential("remove", AuthenticationPolicy.PASSKEY), credential("remaining", "otp"));
    assertThrows(ClientErrorException.class, () -> SupportResourceFactory.removeCredential(session, realm, user, "remove"));
    verify(user.credentialManager(), never()).removeStoredCredentialById(any());
  }
  @Test void successfulRemovalNotifiesWithoutCredentialMaterial() throws Exception {
    methods(credential("remove", "otp"), credential("remaining", AuthenticationPolicy.PASSKEY));
    when(user.getEmail()).thenReturn("person@example.invalid");
    var mail = mock(EmailTemplateProvider.class, RETURNS_SELF); doReturn(mail).when(session).getProvider(EmailTemplateProvider.class);
    SupportResourceFactory.removeCredential(session, realm, user, "remove");
    verify(mail).send(eq("tentuCredentialRemovedSubject"), eq("credential-removed.ftl"), eq(Map.of("method", "otp")));
  }
  @Test void mailFailureMarksTransactionForRollback() throws Exception {
    methods(credential("remove", "otp"), credential("remaining", AuthenticationPolicy.PASSKEY)); when(user.getEmail()).thenReturn("person@example.invalid");
    var mail = mock(EmailTemplateProvider.class, RETURNS_SELF); doReturn(mail).when(session).getProvider(EmailTemplateProvider.class);
    doThrow(new EmailException("private diagnostics")).when(mail).send(anyString(), anyString(), anyMap());
    assertThrows(ServiceUnavailableException.class, () -> SupportResourceFactory.removeCredential(session, realm, user, "remove"));
    verify(session.getTransactionManager()).setRollbackOnly();
  }
  @Test void concurrentMutationCannotEnterCriticalSection() {
    when(session.singleUseObjects().putIfAbsent(anyString(), anyLong())).thenReturn(false);
    assertThrows(ClientErrorException.class, () -> CredentialMutationLock.acquire(session, realm, user));
  }
  @Test void supportRequiresLivePermissionApprovedClientAndFreshPasskey() {
    String permission = "identity:users:credentials:delete";
    var actor = mock(UserModel.class); var role = mock(RoleModel.class);
    var userSession = mock(UserSessionModel.class);
    var token = new org.keycloak.representations.AccessToken(); token.issuedFor("identity-admin-web");
    token.setRealmAccess(new org.keycloak.representations.AccessToken.Access().addRole(permission));
    when(realm.getAttribute(AuthorizationResourceFactory.ACTIVE)).thenReturn("{\"environment\":\"staging\"}");
    var entryRole=mock(RoleModel.class); when(realm.getRole("admin-web:staging:access")).thenReturn(entryRole); when(actor.hasRole(entryRole)).thenReturn(true);
    token.getRealmAccess().addRole("admin-web:staging:access");
    token.setAuth_time(java.time.Instant.now().getEpochSecond()); token.getOtherClaims().put("tentu_auth_method", AuthenticationPolicy.PASSKEY);
    when(realm.getRole(permission)).thenReturn(role); when(actor.hasRole(role)).thenReturn(true);
    when(userSession.getNote(AuthenticationPolicy.METHOD)).thenReturn(AuthenticationPolicy.PASSKEY);
    var auth = new org.keycloak.services.managers.AuthenticationManager.AuthResult(actor, userSession, token, mock(ClientModel.class));
    assertDoesNotThrow(() -> SupportResourceFactory.requireAuthorization(realm, auth, permission, true));
    token.getRealmAccess().getRoles().remove("admin-web:staging:access");
    token.getRealmAccess().addRole("admin-web:production:access");
    assertThrows(ForbiddenException.class, () -> SupportResourceFactory.requireAuthorization(realm, auth, permission, true));
    token.getRealmAccess().addRole("admin-web:staging:access");
    when(actor.hasRole(entryRole)).thenReturn(false);
    assertThrows(ForbiddenException.class, () -> SupportResourceFactory.requireAuthorization(realm, auth, permission, true));
    when(actor.hasRole(entryRole)).thenReturn(true);
    token.setAuth_time(1L); assertThrows(ForbiddenException.class, () -> SupportResourceFactory.requireAuthorization(realm, auth, permission, true));
    token.setAuth_time(java.time.Instant.now().getEpochSecond());
    when(actor.hasRole(role)).thenReturn(false); assertThrows(ForbiddenException.class, () -> SupportResourceFactory.requireAuthorization(realm, auth, permission, true));
    when(actor.hasRole(role)).thenReturn(true); token.issuedFor("unapproved");
    assertThrows(ForbiddenException.class, () -> SupportResourceFactory.requireAuthorization(realm, auth, permission, true));
    assertThrows(NotAuthorizedException.class, () -> SupportResourceFactory.requireAuthorization(realm, null, permission, true));
  }
}
