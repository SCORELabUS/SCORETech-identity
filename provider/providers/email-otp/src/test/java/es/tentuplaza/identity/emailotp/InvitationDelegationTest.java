package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import jakarta.ws.rs.ClientErrorException;
import jakarta.ws.rs.ForbiddenException;
import java.util.*;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.keycloak.models.*;
import org.keycloak.representations.AccessToken;

class InvitationDelegationTest {
  static final String ASSIGN="identity:users:update:roles";
  static final String NEW="research:new-permission";

  static final class Fixture {
    final RealmModel realm=mock(RealmModel.class);
    final UserModel actor=mock(UserModel.class);
    final AccessToken token=new AccessToken();
    final AuthorizationResourceFactory.Registry registry=new AuthorizationResourceFactory.Registry();
    final Map<String,RoleModel> roles=new HashMap<>();
    final Map<String,List<String>> children=new HashMap<>();
    final Set<RoleModel> grants=new HashSet<>();
    Fixture() {
      registry.environment="local";
      for(String name:List.of(ASSIGN,NEW,"admin-web:local:access")) {
        var permission=new AuthorizationResourceFactory.Permission(); permission.name=name; registry.permissions.add(permission);
        live(name);
      }
      definition("administrador",ASSIGN,NEW,"admin-web:local:access");
      definition("researcher",NEW);
      definition("research-team","researcher");
      when(realm.getRole(anyString())).thenAnswer(call -> roles.get(call.getArgument(0)));
      when(realm.getAttribute(AuthorizationResourceFactory.ACTIVE)).thenAnswer(call -> AuthorizationResourceFactory.serialize(registry));
      when(actor.isEnabled()).thenReturn(true);
      when(actor.hasRole(any())).thenAnswer(call -> grants.contains(call.getArgument(0)));
      token.setRealmAccess(new AccessToken.Access().addRole(ASSIGN));
    }
    RoleModel live(String name) {
      var role=mock(RoleModel.class); when(role.getName()).thenReturn(name); when(role.getId()).thenReturn(name+"-id");
      when(role.getCompositesStream()).thenAnswer(call -> children.getOrDefault(name,List.of()).stream().map(roles::get));
      when(role.isComposite()).thenAnswer(call -> !children.getOrDefault(name,List.of()).isEmpty());
      roles.put(name,role); return role;
    }
    void definition(String name,String... permissions) {
      var role=new AuthorizationResourceFactory.Role(); role.name=name; role.permissions=List.of(permissions); registry.roles.add(role);
      children.put(name,List.of(permissions)); if(!roles.containsKey(name)) live(name);
    }
    void assertDelegable(String... names) { InvitationResourceFactory.assertSignedDelegation(realm,actor,token,List.of(names)); }
  }

  @Test void protectedLiveAdministratorCanInviteNewPermissionsMissingFromOlderToken() {
    var f=new Fixture(); f.grants.add(f.roles.get("administrador"));
    assertFalse(f.token.getRealmAccess().isUserInRole(NEW));
    assertDoesNotThrow(() -> f.assertDelegable("researcher","research-team"));
    assertDoesNotThrow(() -> f.assertDelegable("administrador"));
  }

  @Test void administrativeEntryAloneCannotBypassSignedLeafPermissions() {
    var f=new Fixture(); f.grants.add(f.roles.get("admin-web:local:access"));
    assertTrue(AuthenticationPolicy.isAdmin(f.realm,f.actor));
    assertThrows(ForbiddenException.class,() -> f.assertDelegable("research-team"));
    f.token.getRealmAccess().addRole(NEW);
    assertDoesNotThrow(() -> f.assertDelegable("research-team"));
    f.token.getRealmAccess().getRoles().remove(NEW);
    assertThrows(ForbiddenException.class,() -> f.assertDelegable("researcher"));
  }

  @Test void assignmentOperationMustBeSignedBeforeTheFullAdministratorException() {
    var f=new Fixture(); f.grants.add(f.roles.get("administrador"));
    f.token.getRealmAccess().getRoles().remove(ASSIGN); f.token.getRealmAccess().addRole("administrador");
    assertThrows(ForbiddenException.class,() -> f.assertDelegable("researcher"));
    f.token.setRealmAccess(null);
    assertThrows(ForbiddenException.class,() -> f.assertDelegable("researcher"));
    assertThrows(ForbiddenException.class,() -> InvitationResourceFactory.assertSignedDelegation(f.realm,f.actor,null,List.of("researcher")));
  }

  @Test void revokedProtectedRoleImmediatelyRestoresDelegatedTokenLimits() {
    var f=new Fixture(); f.grants.add(f.roles.get("administrador"));
    assertDoesNotThrow(() -> f.assertDelegable("researcher"));
    f.grants.clear();
    assertThrows(ForbiddenException.class,() -> f.assertDelegable("researcher"));
    f.grants.add(f.roles.get("administrador")); when(f.actor.isEnabled()).thenReturn(false);
    assertThrows(ForbiddenException.class,() -> f.assertDelegable("researcher"));
  }

  @Test void fullAdministratorCannotBypassUnknownOrDriftedRoleGraphs() {
    var f=new Fixture(); f.grants.add(f.roles.get("administrador"));
    assertThrows(ClientErrorException.class,() -> f.assertDelegable("unknown"));
    assertThrows(ClientErrorException.class,() -> f.assertDelegable(NEW));
    f.children.put("researcher",List.of("identity:unregistered"));
    assertThrows(ClientErrorException.class,() -> f.assertDelegable("researcher"));
    f.children.put("researcher",List.of(NEW)); when(f.roles.get(NEW).isComposite()).thenReturn(true);
    assertThrows(ClientErrorException.class,() -> f.assertDelegable("researcher"));
  }

  @Test void cyclesAndProtectedRoleInheritanceRemainForbiddenEvenForFullAdministrator() {
    var f=new Fixture(); f.grants.add(f.roles.get("administrador"));
    f.registry.roles.stream().filter(role -> role.name.equals("researcher")).findFirst().orElseThrow().permissions=List.of("research-team");
    f.children.put("researcher",List.of("research-team"));
    assertThrows(ClientErrorException.class,() -> f.assertDelegable("research-team"));
    f.registry.roles.stream().filter(role -> role.name.equals("researcher")).findFirst().orElseThrow().permissions=List.of("administrador");
    f.children.put("researcher",List.of("administrador"));
    assertThrows(ClientErrorException.class,() -> f.assertDelegable("researcher"));
  }
}
