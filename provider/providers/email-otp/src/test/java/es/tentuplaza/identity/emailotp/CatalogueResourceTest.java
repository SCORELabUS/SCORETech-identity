package es.tentuplaza.identity.emailotp;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import java.util.*;
import jakarta.ws.rs.BadRequestException;
class CatalogueResourceTest {
  private AuthorizationResourceFactory.Registry registry() {
    var value = new AuthorizationResourceFactory.Registry();
    for (String name : List.of("administrador","member","retired")) {
      var role = new AuthorizationResourceFactory.Role(); role.name=name; role.description=name;
      role.permissions=new ArrayList<>(); value.roles.add(role);
    }
    return value;
  }
  @Test void activeProjectionDoesNotRestoreRetiredRoles() {
    var result = CatalogueResourceFactory.project(registry(),List.of("administrador","member"));
    var roles = (List<?>)result.get("roles"); assertEquals(2,roles.size());
    assertFalse(roles.toString().contains("retired")); assertEquals("member",result.get("defaultRole"));
  }
  @Test void protectedAndRegistrationRolesCannotDisappear() {
    for (var names : List.of(List.of("member"),List.of("administrador"),List.of("administrador","member","unknown"),List.of("administrador","member","member")))
      assertThrows(BadRequestException.class,()->CatalogueResourceFactory.project(registry(),names));
  }
  @Test void metadataCannotHideAnActiveGrant() {
    var value=registry();value.roles.get(2).permissions=List.of("sphere:admin");
    assertThrows(BadRequestException.class,()->CatalogueResourceFactory.project(value,List.of("administrador","member")));
  }
  @Test void registrationCannotAcquirePermissionsThroughInheritance() {
    var value=registry();value.roles.get(1).permissions=List.of("retired");value.roles.get(2).permissions=List.of("sphere:admin");
    assertThrows(BadRequestException.class,()->CatalogueResourceFactory.project(value,List.of("administrador","member","retired")));
  }
  @Test void activeRegistrationDefaultCanGrantOnlyDirectApplicationEntry() {
    var value = registry();
    var permission = new AuthorizationResourceFactory.Permission();
    permission.name = "sphere:access";
    value.permissions.add(permission);
    value.defaultRole = "retired";
    value.roles.get(2).permissions = List.of(permission.name);
    var active = List.of("administrador", "member", "retired");
    assertEquals("retired", CatalogueResourceFactory.project(value, active).get("defaultRole"));
    for (var rejected : List.of("sphere:admin", "sphere:admin:access", "admin-web:access", "account-web:access")) {
      permission.name = rejected;
      value.roles.get(2).permissions = List.of(rejected);
      assertThrows(BadRequestException.class, () -> CatalogueResourceFactory.project(value, active));
    }
    value.defaultRole = "administrador";
    assertThrows(BadRequestException.class, () -> CatalogueResourceFactory.project(value, active));
  }
  @Test void auditProjectionDoesNotExposeRestorablePayload() {
    var entry=new CatalogueRevisionEntity();entry.id="a".repeat(64);entry.environment="local";entry.actor="actor";entry.reason="Changed roles";entry.operation="publish";entry.createdAt=0;entry.catalogue="private-payload";
    var operation=CatalogueResourceFactory.operation(entry);
    assertFalse(operation.containsKey("catalogue")); assertEquals("1970-01-01T00:00:00Z",operation.get("createdAt"));
  }
}
