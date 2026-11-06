package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.time.Instant;
import java.util.List;
import java.util.stream.Stream;
import jakarta.persistence.EntityManager;
import jakarta.ws.rs.ClientErrorException;
import org.junit.jupiter.api.Test;
import org.keycloak.connections.jpa.JpaConnectionProvider;
import org.keycloak.models.*;

class InvitationStoreTest {
  final KeycloakSession session = mock(KeycloakSession.class, RETURNS_DEEP_STUBS);
  final RealmModel realm = mock(RealmModel.class);
  InvitationStore store() {
    when(session.getContext().getRealm()).thenReturn(realm);
    var provider = mock(JpaConnectionProvider.class);
    when(provider.getEntityManager()).thenReturn(mock(EntityManager.class));
    doReturn(provider).when(session).getProvider(JpaConnectionProvider.class);
    return new InvitationStore(session);
  }
  @Test void rejectsLiveCompositesDriftAndRoleReplacement() {
    var registry = new AuthorizationResourceFactory.Registry();
    var role = new AuthorizationResourceFactory.Role(); role.name = "student";
    registry.roles = List.of(role); registry.environment = "staging";
    var live = mock(RoleModel.class); when(live.getId()).thenReturn("original");
    when(live.getCompositesStream()).thenAnswer(i -> Stream.empty());
    when(realm.getRole("student")).thenReturn(live);
    when(realm.getAttribute(AuthorizationResourceFactory.ACTIVE)).thenReturn(AuthorizationResourceFactory.serialize(registry));
    var store = store(); var original = store.fingerprint(List.of("student"));
    when(live.getId()).thenReturn("replacement");
    assertNotEquals(original, store.fingerprint(List.of("student")));
    var unexpected = mock(RoleModel.class); when(unexpected.getName()).thenReturn("new:privilege");
    when(live.getCompositesStream()).thenAnswer(i -> Stream.of(unexpected));
    assertThrows(ClientErrorException.class, () -> store.fingerprint(List.of("student")));
  }
  @Test void revokedExpiredAndExhaustedInvitationsCannotRedeem() {
    var store = store(); var invite = new InvitationEntity(); invite.capacity = 3;
    invite.revokedAt = 1L; assertEquals("revoked", store.state(invite));
    invite.revokedAt = null; invite.expiresAt = Instant.now().toEpochMilli() - 1;
    assertEquals("expired", store.state(invite));
    invite.expiresAt = null; invite.completed = 3;
    assertEquals("exhausted", store.state(invite));
    when(realm.getAttribute("tentu.invitations.enabled")).thenReturn("true");
    assertThrows(ClientErrorException.class, () -> store.available(invite));
  }
  @Test void invitationSearchMatchesNamesAndRolesWithoutChangingPageOrder() {
    var invitation=new InvitationEntity(); invitation.name="Research invitation"; invitation.roleNames="member\nresearcher";
    assertTrue(InvitationResourceFactory.Resource.matches(invitation,"research"));
    assertTrue(InvitationResourceFactory.Resource.matches(invitation,"member"));
    assertTrue(InvitationResourceFactory.Resource.matches(invitation,""));
    assertFalse(InvitationResourceFactory.Resource.matches(invitation,"absent"));
  }
  @Test void tokensHaveHighEntropyAndOnlyTheirHashIsPersistent() {
    var first = InvitationStore.token(); var second = InvitationStore.token();
    assertTrue(first.matches("[A-Za-z0-9_-]{43}")); assertNotEquals(first, second);
    assertEquals(64, InvitationStore.hash(first).length());
    assertNotEquals(first, InvitationStore.hash(first));
  }
  @Test void deletionLocksAndRemovesOnlyTheInvitation() {
    var em=mock(EntityManager.class);
    when(session.getContext().getRealm()).thenReturn(realm);
    when(realm.getId()).thenReturn("realm");
    var provider=mock(JpaConnectionProvider.class);
    when(provider.getEntityManager()).thenReturn(em);
    doReturn(provider).when(session).getProvider(JpaConnectionProvider.class);
    var invitation=new InvitationEntity(); invitation.realmId="realm"; invitation.revokedAt=1L;
    when(em.find(InvitationEntity.class,"invite",jakarta.persistence.LockModeType.PESSIMISTIC_WRITE)).thenReturn(invitation);
    new InvitationStore(session).delete("invite");
    var order=inOrder(em);
    order.verify(em).find(InvitationEntity.class,"invite",jakarta.persistence.LockModeType.PESSIMISTIC_WRITE);
    order.verify(em).remove(invitation);
    order.verify(em).flush();
    verifyNoMoreInteractions(em);
  }
  @Test void deletionRejectsNonExpiredInvitationsAndAllowsExpiredOnesUnderTheSameLock() {
    var em=mock(EntityManager.class);
    when(session.getContext().getRealm()).thenReturn(realm); when(realm.getId()).thenReturn("realm");
    var provider=mock(JpaConnectionProvider.class); when(provider.getEntityManager()).thenReturn(em);
    doReturn(provider).when(session).getProvider(JpaConnectionProvider.class);
    var invitation=new InvitationEntity(); invitation.realmId="realm";
    when(em.find(InvitationEntity.class,"invite",jakarta.persistence.LockModeType.PESSIMISTIC_WRITE)).thenReturn(invitation);
    var store=new InvitationStore(session);
    assertThrows(ClientErrorException.class,()->store.delete("invite"));
    invitation.expiresAt=Instant.now().toEpochMilli()+60000;
    assertThrows(ClientErrorException.class,()->store.delete("invite"));
    invitation.completed=invitation.capacity;
    assertThrows(ClientErrorException.class,()->store.delete("invite"));
    verify(em,never()).remove(any());
    invitation.expiresAt=Instant.now().toEpochMilli()-1;
    assertDoesNotThrow(()->store.delete("invite"));
    verify(em).remove(invitation); verify(em).flush();
  }

  @Test void deletionRejectsAnotherRealmAndMissingInvitation() {
    var em=mock(EntityManager.class);
    when(session.getContext().getRealm()).thenReturn(realm);
    when(realm.getId()).thenReturn("realm");
    var provider=mock(JpaConnectionProvider.class);
    when(provider.getEntityManager()).thenReturn(em);
    doReturn(provider).when(session).getProvider(JpaConnectionProvider.class);
    var other=new InvitationEntity(); other.realmId="other";
    when(em.find(InvitationEntity.class,"other",jakarta.persistence.LockModeType.PESSIMISTIC_WRITE)).thenReturn(other);
    var store=new InvitationStore(session);
    assertThrows(jakarta.ws.rs.NotFoundException.class,()->store.delete("other"));
    assertThrows(jakarta.ws.rs.NotFoundException.class,()->store.delete("missing"));
    verify(em,never()).remove(any());
  }
}
