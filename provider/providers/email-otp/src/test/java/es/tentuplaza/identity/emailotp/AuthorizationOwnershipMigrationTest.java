package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import jakarta.ws.rs.ClientErrorException;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.keycloak.models.*;

class AuthorizationOwnershipMigrationTest {
  final String permission = "opositor-portal:production:access";
  AuthorizationResourceFactory.Permission permission(String owner) {
    var p = new AuthorizationResourceFactory.Permission(); p.name = permission; p.owner = owner; return p;
  }
  AuthorizationResourceFactory.Registry registry(String owner, String revision) {
    var r = new AuthorizationResourceFactory.Registry(); r.environment = "production"; r.generation = 9;
    r.revision = revision; r.permissions = List.of(permission(owner)); return r;
  }
  AuthorizationResourceFactory.OwnershipMigration migration(String revision) {
    var m = new AuthorizationResourceFactory.OwnershipMigration(); m.permission = permission;
    m.fromOwner = "identity-config-sync"; m.toOwner = "opositor-portal-api"; m.previousRevision = revision; return m;
  }
  RealmModel realm(String owner) {
    var realm = mock(RealmModel.class); var role = mock(RoleModel.class);
    when(realm.getRole(permission)).thenReturn(role);
    when(role.getFirstAttribute(AuthorizationResourceFactory.OWNER)).thenReturn(owner); return realm;
  }
  @Test void undeclaredOwnershipChangesStillFail() {
    assertThrows(ClientErrorException.class, () -> AuthorizationResourceFactory.validateOwnership(
        realm("identity-config-sync"), registry("opositor-portal-api", "new"), registry("identity-config-sync", "old")));
  }
  @Test void declaredTransferRequiresExactPreviousRevisionAndStoredOwner() {
    var value = registry("opositor-portal-api", "new"); value.ownershipMigrations = List.of(migration("old"));
    assertDoesNotThrow(() -> AuthorizationResourceFactory.validateOwnership(realm("identity-config-sync"), value, registry("identity-config-sync", "old")));
    assertThrows(ClientErrorException.class, () -> AuthorizationResourceFactory.validateOwnership(realm("identity-config-sync"), value, registry("identity-config-sync", "different")));
    assertThrows(ClientErrorException.class, () -> AuthorizationResourceFactory.validateOwnership(realm("unrelated-service"), value, registry("identity-config-sync", "old")));
    assertThrows(ClientErrorException.class, () -> AuthorizationResourceFactory.validateOwnership(realm("identity-config-sync"), value, null));
  }
  @Test void completedTransfersAreIdempotentAcrossCumulativePromotions() {
    var value = registry("opositor-portal-api", "later"); value.ownershipMigrations = List.of(migration("old"));
    assertDoesNotThrow(() -> AuthorizationResourceFactory.validateOwnership(realm("opositor-portal-api"), value, registry("opositor-portal-api", "new")));
  }
  @Test void migrationCannotClaimAnotherPermissionOrOrdinaryRole() {
    var value = registry("opositor-portal-api", "new"); var m = migration("old"); m.toOwner = "wrong";
    value.ownershipMigrations = List.of(m);
    assertThrows(jakarta.ws.rs.BadRequestException.class, () -> AuthorizationResourceFactory.validate(value));
    m.toOwner = "opositor-portal-api";
    var realm = realm("identity-config-sync"); when(realm.getRole(permission).isComposite()).thenReturn(true);
    assertThrows(ClientErrorException.class, () -> AuthorizationResourceFactory.validateOwnership(realm, value, registry("identity-config-sync", "old")));
  }
  @Test void reconcileUpdatesTheSameRoleWithoutDeletingIt() {
    var previous = registry("identity-config-sync", "old"); var value = registry("opositor-portal-api", "new");
    value.ownershipMigrations = List.of(migration("old"));
    var realm = realm("identity-config-sync"); var permissionRole = realm.getRole(permission);
    when(realm.getRole("administrador")).thenReturn(mock(RoleModel.class));
    AuthorizationResourceFactory.reconcile(realm, value, previous);
    verify(permissionRole).setSingleAttribute(AuthorizationResourceFactory.OWNER, "opositor-portal-api");
    verify(realm, never()).removeRole(permissionRole);
    verify(realm, never()).addRole(permission);
  }
}
