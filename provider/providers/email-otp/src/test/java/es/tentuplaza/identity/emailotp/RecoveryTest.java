package es.tentuplaza.identity.emailotp;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import java.util.stream.Stream;
import jakarta.ws.rs.*;
import jakarta.persistence.*;
import org.junit.jupiter.api.Test;
import org.keycloak.models.*;
import org.keycloak.connections.jpa.JpaConnectionProvider;
import org.keycloak.email.*;

class RecoveryTest {
  final KeycloakSession session=mock(KeycloakSession.class,RETURNS_DEEP_STUBS);
  final RealmModel realm=mock(RealmModel.class);
  final UserModel actor=mock(UserModel.class), target=mock(UserModel.class);
  final EntityManager em=mock(EntityManager.class);
  RecoveryStore setup() {
    when(session.getContext().getRealm()).thenReturn(realm); when(realm.getId()).thenReturn("realm");
    var jpa=mock(JpaConnectionProvider.class); doReturn(jpa).when(session).getProvider(JpaConnectionProvider.class); when(jpa.getEntityManager()).thenReturn(em);
    when(realm.getRolesStream()).thenAnswer(i -> Stream.empty());
    when(actor.getId()).thenReturn("actor"); when(actor.isEnabled()).thenReturn(true);
    when(target.getId()).thenReturn("target"); when(target.isEnabled()).thenReturn(true);
    when(target.getEmail()).thenReturn("person@example.invalid"); when(target.isEmailVerified()).thenReturn(true);
    when(session.users().getUserById(realm,"actor")).thenReturn(actor);
    when(session.users().getUserById(realm,"target")).thenReturn(target);
    when(realm.getAttribute(AuthorizationResourceFactory.ACTIVE)).thenReturn("{\"environment\":\"staging\"}");
    for(var name:new String[]{RecoveryStore.CREATE,"admin-web:staging:access"}) { var role=mock(RoleModel.class); when(realm.getRole(name)).thenReturn(role); when(actor.hasRole(role)).thenReturn(true); }
    return new RecoveryStore(session);
  }
  RecoveryEntity issued() {
    var r=new RecoveryEntity(); r.realmId="realm"; r.userId="target"; r.actorId="actor"; r.environment="staging"; r.state="issued"; r.expiresAt=RecoveryStore.now()+600000; return r;
  }
  @Test void validatesExpiryRealmStateAndLiveAuthority() {
    var store=setup(); var value=issued(); assertDoesNotThrow(() -> store.available(value,"issued"));
    value.expiresAt=0; assertThrows(ClientErrorException.class,() -> store.available(value,"issued"));
    value.expiresAt=RecoveryStore.now()+600000; value.realmId="other"; assertThrows(ClientErrorException.class,() -> store.available(value,"issued"));
    value.realmId="realm"; value.state="claimed"; assertThrows(ClientErrorException.class,() -> store.available(value,"issued"));
    value.state="issued"; when(actor.hasRole(realm.getRole(RecoveryStore.CREATE))).thenReturn(false);
    assertThrows(ForbiddenException.class,() -> store.available(value,"issued"));
  }
  @Test void protectsOwnDisabledServiceAndAdministrativeAccounts() {
    setup(); assertDoesNotThrow(() -> RecoveryStore.eligible(realm,target,actor));
    when(target.getId()).thenReturn("actor"); assertThrows(ForbiddenException.class,() -> RecoveryStore.eligible(realm,target,actor));
    when(target.getId()).thenReturn("target"); when(target.isEnabled()).thenReturn(false); assertThrows(ForbiddenException.class,() -> RecoveryStore.eligible(realm,target,actor));
    when(target.isEnabled()).thenReturn(true); when(target.getServiceAccountClientLink()).thenReturn("service"); assertThrows(ForbiddenException.class,() -> RecoveryStore.eligible(realm,target,actor));
    when(target.getServiceAccountClientLink()).thenReturn(null); var role=mock(RoleModel.class); when(realm.getRole("administrador")).thenReturn(role); when(target.hasRole(role)).thenReturn(true);
    assertThrows(ForbiddenException.class,() -> RecoveryStore.eligible(realm,target,actor));
    when(target.hasRole(role)).thenReturn(false); when(role.getName()).thenReturn("admin-web:staging:access"); when(realm.getRolesStream()).thenAnswer(i -> Stream.of(role)); when(target.hasRole(role)).thenReturn(true);
    assertThrows(ForbiddenException.class,() -> RecoveryStore.eligible(realm,target,actor));
  }
  @Test void unavailableEmailAndRevokedIssuerBlockRecovery() {
    var store=setup(); var value=issued(); when(target.isEmailVerified()).thenReturn(false); assertThrows(ForbiddenException.class,() -> store.available(value,"issued"));
    when(target.isEmailVerified()).thenReturn(true); when(actor.isEnabled()).thenReturn(false); assertThrows(ForbiddenException.class,() -> store.available(value,"issued"));
    when(actor.isEnabled()).thenReturn(true); value.environment="production"; assertThrows(ForbiddenException.class,() -> store.available(value,"issued"));
  }
  @Test void locksRowsAndRejectsCrossRealmIds() {
    var store=setup(); var value=issued(); when(em.find(RecoveryEntity.class,"id",LockModeType.PESSIMISTIC_WRITE)).thenReturn(value);
    assertSame(value,store.get("id")); value.realmId="other"; assertThrows(NotFoundException.class,() -> store.get("id"));
  }
  @Test void failedNotificationRollsBackAndSecretsAreNotStoredInPlaintext() throws Exception {
    var store=setup(); var mail=mock(EmailTemplateProvider.class,RETURNS_SELF); doReturn(mail).when(session).getProvider(EmailTemplateProvider.class);
    doThrow(new EmailException("fixture")).when(mail).send(anyString(),anyString(),anyMap());
    assertThrows(ServiceUnavailableException.class,() -> store.notify(target,"issued")); verify(session.getTransactionManager()).setRollbackOnly();
    String token=InvitationStore.token(); assertEquals(43,token.length()); assertNotEquals(token,InvitationStore.hash(token));
    assertTrue(RecoveryResourceFactory.matches("proof","proof")); assertFalse(RecoveryResourceFactory.matches(null,"proof")); assertFalse(RecoveryResourceFactory.matches("other","proof"));
  }
}
