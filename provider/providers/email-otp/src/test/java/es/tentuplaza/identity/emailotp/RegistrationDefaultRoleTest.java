package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import jakarta.ws.rs.ServiceUnavailableException;
import org.junit.jupiter.api.Test;
import org.keycloak.models.*;

class RegistrationDefaultRoleTest {
  final RealmModel realm = mock(RealmModel.class);

  @Test void noDefaultPreservesExistingRegistrationPolicy() {
    assertNull(RegistrationPolicy.defaultRole(realm));
    when(realm.getAttribute(RegistrationPolicy.DEFAULT_ROLE)).thenReturn("");
    assertNull(RegistrationPolicy.defaultRole(realm));
  }

  @Test void onlyAnActiveBusinessRoleCanBeAssigned() {
    var role = mock(RoleModel.class);
    when(realm.getRole("interesado")).thenReturn(role);
    when(realm.getAttribute(RegistrationPolicy.DEFAULT_ROLE)).thenReturn("interesado");
    when(realm.getAttribute(AuthorizationResourceFactory.ACTIVE)).thenReturn(
        "{\"roles\":[{\"name\":\"interesado\"}]}");
    assertSame(role, RegistrationPolicy.defaultRole(realm));
    when(realm.getAttribute(AuthorizationResourceFactory.ACTIVE)).thenReturn("{\"roles\":[]}");
    assertThrows(ServiceUnavailableException.class, () -> RegistrationPolicy.defaultRole(realm));
  }

  @Test void missingOrAdministrativeDefaultFailsClosed() {
    when(realm.getAttribute(RegistrationPolicy.DEFAULT_ROLE)).thenReturn("interesado");
    assertThrows(ServiceUnavailableException.class, () -> RegistrationPolicy.defaultRole(realm));
    when(realm.getAttribute(RegistrationPolicy.DEFAULT_ROLE)).thenReturn("administrador");
    assertThrows(ServiceUnavailableException.class, () -> RegistrationPolicy.defaultRole(realm));
    var role = mock(RoleModel.class); var admin = mock(RoleModel.class);
    when(realm.getAttribute(RegistrationPolicy.DEFAULT_ROLE)).thenReturn("interesado");
    when(realm.getRole("interesado")).thenReturn(role);
    when(realm.getRole("administrador")).thenReturn(admin);
    when(role.hasRole(admin)).thenReturn(true);
    assertThrows(ServiceUnavailableException.class, () -> RegistrationPolicy.defaultRole(realm));
  }
}
