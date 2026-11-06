package es.tentuplaza.identity.emailotp;

import jakarta.persistence.LockModeType;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.Response;
import java.util.*;
import org.keycloak.Config;
import org.keycloak.connections.jpa.JpaConnectionProvider;
import org.keycloak.models.*;
import org.keycloak.models.jpa.entities.UserEntity;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.services.resource.*;

/** Apply a field/attribute patch against the current model, never a stale user representation. */
public final class UserMutationResourceFactory implements RealmResourceProviderFactory {
  private static final Set<String> PROFILE_ATTRIBUTES = Set.of("tentuMarketing", "tentuPreferences", "tentuAvatar", "tentuPhone", "tentuTaxDocumentType", "tentuTaxDocumentNumber", "tentuUpdatedAt", "tentuPasskeySuggestionSeen");
  private static final Set<String> ADMIN_ATTRIBUTES = Set.of("tentuWooCustomerId", "tentuWooStoreId", "tentuInvitationState");
  public String getId() { return "tentu-user-mutations"; }
  public RealmResourceProvider create(KeycloakSession session) { return new RealmResourceProvider() {
    public Object getResource() { return new Resource(session); }
    public void close() { }
  }; }
  public void init(Config.Scope config) { }
  public void postInit(KeycloakSessionFactory factory) { }
  public void close() { }

  public static final class Resource {
    private final KeycloakSession session;
    Resource(KeycloakSession session) { this.session = session; }
    @PATCH @Path("users/{userId}") @Consumes("application/json")
    public Response patch(@PathParam("userId") String userId, Map<String, Object> body) {
      var auth = new AppAuthManager.BearerTokenAuthenticator(session).setAudience("realm-management").authenticate();
      if (auth == null || auth.getClient() == null || auth.getUser() == null) throw new NotAuthorizedException("Bearer");
      var client = auth.getClient();
      String id = client.getClientId();
      if (!Set.of("identity-account-service", "identity-admin-service").contains(id)
          || !id.equals(auth.getToken().getIssuedFor()) || !client.isEnabled() || client.isPublicClient()
          || !client.isServiceAccountsEnabled() || !auth.getUser().isEnabled()
          || !client.getId().equals(auth.getUser().getServiceAccountClientLink()))
        throw new ForbiddenException("Dedicated identity service account required");
      boolean admin = id.equals("identity-admin-service");
      validate(session, body, admin);
      var realm = session.getContext().getRealm();
      var management = realm.getClientByClientId("realm-management");
      var manageUsers = management == null ? null : management.getRole("manage-users");
      if (manageUsers == null || !auth.getUser().hasRole(manageUsers)
          || auth.getToken().getResourceAccess("realm-management") == null
          || !auth.getToken().getResourceAccess("realm-management").isUserInRole("manage-users"))
        throw new ForbiddenException("Live user-management permission required");
      var em = session.getProvider(JpaConnectionProvider.class).getEntityManager();
      // Both API writers lock this row before loading mutable state; works across replicas.
      var entity = em.find(UserEntity.class, userId, LockModeType.PESSIMISTIC_WRITE);
      if (entity == null || !realm.getId().equals(entity.getRealmId())) throw new NotFoundException();
      em.refresh(entity);
      var cache = session.getProvider(org.keycloak.models.cache.UserCache.class);
      if (cache != null) cache.evict(realm, session.users().getUserById(realm, userId));
      var user = session.users().getUserById(realm, userId);
      try { apply(user, body); em.flush(); }
      catch (RuntimeException error) { if (!PersistenceConflicts.duplicate(error)) throw error; session.getTransactionManager().setRollbackOnly(); throw new ClientErrorException("This email is already registered.", 409); }
      return Response.noContent().header("Cache-Control", "no-store").build();
    }
  }
  static void validate(KeycloakSession session, Map<String, Object> body, boolean admin) {
    var fields = admin ? Set.of("firstName", "lastName", "email", "emailVerified", "enabled", "attributes") : Set.of("firstName", "lastName", "attributes");
    if (body == null || body.isEmpty() || !fields.containsAll(body.keySet())) throw new BadRequestException("Campos no permitidos.");
    for (String name : List.of("firstName", "lastName")) if (body.containsKey(name)
        && (!(body.get(name) instanceof String value) || !RegistrationPolicy.validName(session, value, name.equals("firstName"))))
      throw new BadRequestException("Invalid name.");
    for (String name : List.of("enabled", "emailVerified")) if (body.containsKey(name) && !(body.get(name) instanceof Boolean)) throw new BadRequestException("Invalid state.");
    if (body.containsKey("email") && (!(body.get("email") instanceof String email) || email.length() > 254 || !email.matches("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"))) throw new BadRequestException("Invalid email address.");
    if (body.containsKey("attributes")) {
      if (!(body.get("attributes") instanceof Map<?, ?> attributes) || attributes.size() > 20) throw new BadRequestException("Invalid profile attributes.");
      for (var entry : attributes.entrySet()) {
        if (!(entry.getKey() instanceof String name) || (!PROFILE_ATTRIBUTES.contains(name) && !(admin && ADMIN_ATTRIBUTES.contains(name)))
            || !(entry.getValue() instanceof List<?> values) || values.size() > 1 || values.stream().anyMatch(v -> !(v instanceof String s) || s.length() > 4096))
          throw new BadRequestException("Atributo no permitido.");
        if (name.equals("tentuMarketing") && (values.size() != 1 || !Set.of("true", "false").contains(values.getFirst()))) throw new BadRequestException("Invalid preference.");
        if (name.equals("tentuPhone") && !values.isEmpty() && !RegistrationPolicy.validPhone((String) values.getFirst())) throw new BadRequestException("Invalid phone number.");
      }
    }
  }
  @SuppressWarnings("unchecked")
  static void apply(UserModel user, Map<String, Object> body) {
    if (body.containsKey("firstName")) user.setFirstName(((String) body.get("firstName")).trim());
    if (body.containsKey("lastName")) user.setLastName(((String) body.get("lastName")).trim());
    if (body.containsKey("enabled")) user.setEnabled((Boolean) body.get("enabled"));
    if (body.containsKey("emailVerified")) user.setEmailVerified((Boolean) body.get("emailVerified"));
    if (body.containsKey("email")) {
      String email = ((String) body.get("email")).trim().toLowerCase(Locale.ROOT);
      if (!email.equals(user.getEmail())) { user.setEmail(email); user.setEmailVerified(false); }
    }
    if (body.get("attributes") instanceof Map<?, ?> attributes) for (var entry : attributes.entrySet()) {
      String name = (String) entry.getKey(); var values = (List<String>) entry.getValue();
      if (values.isEmpty()) user.removeAttribute(name); else user.setAttribute(name, values);
    }
  }
}
