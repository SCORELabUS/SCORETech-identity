package es.tentuplaza.identity.emailotp;

import java.lang.reflect.Proxy;
import java.util.Map;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.UserModel;
import org.keycloak.validate.ValidationContext;
import org.keycloak.validate.ValidatorConfig;
import org.keycloak.userprofile.validator.PersonNameProhibitedCharactersValidator;

final class RegistrationPolicy {
  static final String DEFAULT_ROLE = "tentu.registration.default-role";

  static org.keycloak.models.RoleModel defaultRole(org.keycloak.models.RealmModel realm) {
    String name = realm.getAttribute(DEFAULT_ROLE);
    if (name == null || name.isBlank()) return null;
    AuthorizationResourceFactory.name(name);
    var registry = AuthorizationResourceFactory.read(realm);
    var role = realm.getRole(name);
    var admin = realm.getRole(AuthorizationResourceFactory.ADMIN);
    if (AuthorizationResourceFactory.ADMIN.equals(name) || role == null || role.isClientRole()
        || (admin != null && role.hasRole(admin))
        || (registry != null && registry.roles.stream().noneMatch(item -> name.equals(item.name))))
      throw new jakarta.ws.rs.ServiceUnavailableException("Invalid registration default role");
    return role;
  }

  static boolean validName(KeycloakSession session, String value, boolean required) {
    if (value == null || value.length() > 100 || (required && value.isBlank())) return false;
    var validation = new ValidationContext(session);
    PersonNameProhibitedCharactersValidator.INSTANCE.validate(value, "name", validation, ValidatorConfig.EMPTY);
    return validation.isValid();
  }
  static String phone(String value) { return value == null ? "" : value.trim().replaceAll("[\\s()-]", ""); }
  static boolean validPhone(String value) { return value.isEmpty() || value.matches("^\\+[1-9][0-9]{6,14}$"); }

  /** Email rendering only. This immutable projection is never attached to an authentication session or persisted. */
  static UserModel pendingRecipient(String email) {
    return (UserModel) Proxy.newProxyInstance(UserModel.class.getClassLoader(), new Class<?>[]{UserModel.class}, (proxy, method, args) -> {
      return switch (method.getName()) {
        case "getEmail", "getUsername" -> email;
        case "getId" -> "pending-registration";
        case "getFirstName", "getLastName" -> "";
        case "getAttributes" -> Map.of();
        case "getFirstAttribute", "getFederationLink", "getServiceAccountClientLink", "getCreatedTimestamp" -> null;
        case "getAttributeStream", "getRequiredActionsStream", "getGroupsStream", "getRoleMappingsStream", "getRealmRoleMappingsStream" -> java.util.stream.Stream.empty();
        case "isEnabled" -> true;
        case "isEmailVerified", "isMemberOf", "hasRole", "isFederated" -> false;
        case "toString" -> "Pending email recipient";
        case "hashCode" -> System.identityHashCode(proxy);
        case "equals" -> proxy == args[0];
        default -> throw new UnsupportedOperationException("Read-only email recipient: " + method.getName());
      };
    });
  }
}
