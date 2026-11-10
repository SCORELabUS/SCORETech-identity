package es.tentuplaza.identity.emailotp;

import jakarta.ws.rs.*;
import jakarta.ws.rs.core.Response;
import java.util.*;
import org.keycloak.Config;
import org.keycloak.models.*;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.services.resource.RealmResourceProvider;
import org.keycloak.services.resource.RealmResourceProviderFactory;
import org.keycloak.util.JsonSerialization;

/** One request transaction publishes the catalogue and its administrative composite together. */
public final class AuthorizationResourceFactory implements RealmResourceProviderFactory {
  static final String ACTIVE = "tentu.authorization.active";
  static final String OWNED_ROLES = "tentu.authorization.owned-roles";
  static final String OWNER = "tentu.authorization.owner";
  static final String ADMIN = "administrador";
  static final String REGISTRY_OWNER = "authorization-registry";

  public String getId() { return "tentu-authorization"; }
  public RealmResourceProvider create(KeycloakSession session) {
    return new RealmResourceProvider() {
      public Object getResource() { return new Resource(session); }
      public void close() { }
    };
  }
  public void init(Config.Scope config) { }
  public void postInit(KeycloakSessionFactory factory) { }
  public void close() { }

  public static final class Registry {
    public String environment;
    public long generation;
    public String revision;
    public List<Permission> permissions = new ArrayList<>();
    public List<OwnershipMigration> ownershipMigrations = new ArrayList<>();
    public List<Role> roles = new ArrayList<>();
    public List<Group> groups = new ArrayList<>();
    // Omit for legacy snapshots: absence never reopens an already restricted client.
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    public List<ClientTokenScopes.Scope> clientTokenScopes;
    public List<ClientAccessRules.Rule> accessRules;
    public List<String> managedAccessClients;
  }
  public static final class OwnershipMigration {
    public String permission;
    public String fromOwner;
    public String toOwner;
    public String previousRevision;
  }
  public static final class Permission {
    public String name;
    public String description;
    public String owner;
  }
  public static final class Role {
    public String name;
    public String description;
    public List<String> permissions = new ArrayList<>();
  }
  public static final class Group {
    public String name;
    public List<String> roles = new ArrayList<>();
  }

  public static final class Resource {
    private final KeycloakSession session;
    Resource(KeycloakSession session) { this.session = session; }

    private void authorize(boolean write) {
      var auth = new AppAuthManager.BearerTokenAuthenticator(session)
          .setAudience("identity-provider").authenticate();
      if (auth == null || auth.getUser() == null || auth.getClient() == null)
        throw new NotAuthorizedException("Bearer");
      var client = auth.getClient();
      String id = client.getClientId();
      if (!("identity-config-sync".equals(id) || (!write && "identity-admin-service".equals(id)))
          || !id.equals(auth.getToken().getIssuedFor()) || !client.isEnabled()
          || client.isPublicClient() || !client.isServiceAccountsEnabled()
          || !auth.getUser().isEnabled()
          || !client.getId().equals(auth.getUser().getServiceAccountClientLink()))
        throw new ForbiddenException("Dedicated reconciliation service account required");
    }

    @GET @Path("snapshot") @Produces("application/json")
    public Response get() {
      authorize(false);
      var active = read(session.getContext().getRealm());
      Object entity = active != null ? active : Map.of("generation", 0, "status", "uninitialized");
      return Response.ok(entity).header("Cache-Control", "no-store").build();
    }

    @PUT @Path("snapshot") @Consumes("application/json") @Produces("application/json")
    public Response put(Registry registry) {
      authorize(true);
      validate(registry);
      var realm = session.getContext().getRealm();
      acquire(session, realm);
      var previous = read(realm);
      if (previous != null) {
        if (!previous.environment.equals(registry.environment))
          throw new ClientErrorException("Authorization environment cannot change", 409);
        if (previous.generation == registry.generation && previous.revision.equals(registry.revision)) {
          // Revision is an identifier, not proof that retry content is identical.
          if (!serialize(previous).equals(serialize(registry)))
            throw new ClientErrorException("Revision payload does not match the active snapshot", 409);
          return Response.ok(previous).header("Cache-Control", "no-store").build();
        }
        if (registry.generation <= previous.generation)
          throw new ClientErrorException("Obsolete authorization generation", 409);
        if (previous.revision.equals(registry.revision))
          throw new ClientErrorException("A new generation requires a new revision", 409);
      }
      validateOwnership(realm, registry, previous);
      // Serialize before mutation: serialization failure cannot leave a partial import.
      String encoded = serialize(registry);
      try {
        reconcile(realm, registry, previous);
        realm.setAttribute(ACTIVE, encoded);
      } catch (RuntimeException error) {
        session.getTransactionManager().setRollbackOnly();
        throw error;
      }
      return Response.ok(registry).header("Cache-Control", "no-store").build();
    }
  }

  static void acquire(KeycloakSession session, RealmModel realm) {
    String key = "tentu-authorization-mutation:" + realm.getId();
    if (!session.singleUseObjects().putIfAbsent(key, 900))
      throw new ClientErrorException("Authorization reconciliation already in progress", 409);
    session.getTransactionManager().enlistAfterCompletion(new AbstractKeycloakTransaction() {
      protected void commitImpl() { session.singleUseObjects().remove(key); }
      protected void rollbackImpl() { session.singleUseObjects().remove(key); }
    });
  }

  static Registry read(RealmModel realm) {
    String value = realm.getAttribute(ACTIVE);
    if (value == null) return null;
    try { return JsonSerialization.readValue(value, Registry.class); }
    catch (Exception error) { throw new ServiceUnavailableException("Invalid stored authorization registry"); }
  }

  static String serialize(Object value) {
    try { return JsonSerialization.writeValueAsString(value); }
    catch (Exception error) { throw new BadRequestException("Cannot serialize authorization registry"); }
  }

  static void validate(Registry value) {
    if (value == null || value.environment == null || !Set.of("local", "development", "dev", "staging", "production").contains(value.environment)
        || value.generation < 1 || value.revision == null || !value.revision.matches("[A-Za-z0-9._:-]{1,160}")
        || value.permissions == null || value.roles == null || value.groups == null || value.ownershipMigrations == null
        || value.ownershipMigrations.size() > 1000 || value.permissions.size() > 10000 || value.roles.size() > 2000 || value.groups.size() > 2000)
      throw new BadRequestException("Invalid authorization registry envelope");
    var permissions = new HashSet<String>();
    var graph = new LinkedHashMap<String, List<String>>();
    for (var item : value.permissions) {
      if (item == null) throw new BadRequestException("Invalid permission");
      name(item.name);
      if (!item.name.contains(":") || ADMIN.equals(item.name) || item.owner == null
          || !item.owner.matches("[A-Za-z0-9][A-Za-z0-9._/-]{0,159}") || !permissions.add(item.name))
        throw new BadRequestException("Duplicate or invalid owned permission");
    }
    var migratedPermissions = new HashSet<String>();
    for (var migration : value.ownershipMigrations) {
      if (migration == null || migration.permission == null || !migratedPermissions.add(migration.permission)
          || migration.fromOwner == null || migration.toOwner == null || migration.fromOwner.equals(migration.toOwner)
          || migration.previousRevision == null || !migration.previousRevision.matches("[A-Za-z0-9._:-]{1,160}")
          || value.permissions.stream().noneMatch(p -> p.name.equals(migration.permission) && p.owner.equals(migration.toOwner)))
        throw new BadRequestException("Invalid explicit permission ownership migration");
    }
    for (var item : value.roles) {
      if (item == null) throw new BadRequestException("Invalid role");
      name(item.name);
      if (permissions.contains(item.name) || graph.containsKey(item.name) || item.permissions == null)
        throw new BadRequestException("Duplicate or invalid role");
      graph.put(item.name, item.permissions);
    }
    for (var item : value.roles) {
      if (ADMIN.equals(item.name)) {
        if (item.permissions.size() != permissions.size() || !new HashSet<>(item.permissions).equals(permissions))
          throw new BadRequestException("administrador must include exactly all active permissions");
      } else {
        uniqueReferences(item.permissions);
        for (var reference : item.permissions)
          if (ADMIN.equals(reference) || (!permissions.contains(reference) && !graph.containsKey(reference)))
            throw new BadRequestException("Unknown or protected role reference");
      }
    }
    var visited = new HashSet<String>();
    for (String role : graph.keySet()) cycle(role, graph, visited, new HashSet<>());
    var groups = new HashSet<String>();
    for (var item : value.groups) {
      if (item == null) throw new BadRequestException("Invalid group");
      name(item.name);
      if (item.name.contains("/") || !groups.add(item.name) || item.roles == null)
        throw new BadRequestException("Duplicate or invalid top-level group");
      uniqueReferences(item.roles);
      for (String reference : item.roles)
        if (!ADMIN.equals(reference) && !graph.containsKey(reference) && !permissions.contains(reference))
          throw new BadRequestException("Unknown group role reference");
    }
    ClientTokenScopes.validate(value.clientTokenScopes, permissions);
    ClientAccessRules.validate(value.accessRules, permissions, value.environment);
  }

  static void name(String value) {
    if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,159}")
        || value.equals("offline_access") || value.equals("uma_authorization") || value.startsWith("default-roles-"))
      throw new BadRequestException("Invalid or reserved authorization name");
  }
  static void uniqueReferences(List<String> references) {
    if (references.size() > 10000 || new HashSet<>(references).size() != references.size())
      throw new BadRequestException("Duplicate or excessive role references");
    for (String reference : references) name(reference);
  }
  static void cycle(String current, Map<String, List<String>> graph, Set<String> visited, Set<String> stack) {
    if (visited.contains(current) || !graph.containsKey(current)) return;
    if (!stack.add(current)) throw new BadRequestException("Role composition cycle");
    for (String next : graph.get(current)) cycle(next, graph, visited, stack);
    stack.remove(current);
    visited.add(current);
  }

  static void validateOwnership(RealmModel realm, Registry value, Registry previous) {
    Set<String> previousPermissions = new HashSet<>();
    Map<String, String> previousOwners = new HashMap<>();
    if (previous != null) for (var item : previous.permissions) {
      previousPermissions.add(item.name); previousOwners.put(item.name, item.owner);
    }
    var ownedRoles = ownedRoles(realm);
    var migrations = new HashMap<String, OwnershipMigration>();
    for (var migration : value.ownershipMigrations) {
      var existing = realm.getRole(migration.permission);
      String before = previousOwners.get(migration.permission);
      // Completed declarations remain harmless across cumulative promotion commits.
      boolean completed = migration.toOwner.equals(before) && existing != null
          && migration.toOwner.equals(existing.getFirstAttribute(OWNER));
      boolean authorizedTransition = previous != null && migration.previousRevision.equals(previous.revision)
          && migration.fromOwner.equals(before) && existing != null
          && migration.fromOwner.equals(existing.getFirstAttribute(OWNER)) && !existing.isComposite();
      if (!completed && !authorizedTransition)
        throw new ClientErrorException("Ownership migration does not match the active revision and owner", 409);
      migrations.put(migration.permission, migration);
    }
    for (var item : value.permissions) {
      var role = realm.getRole(item.name);
      boolean migrating = migrations.containsKey(item.name);
      if (previousOwners.containsKey(item.name) && !previousOwners.get(item.name).equals(item.owner) && !migrating)
        throw new ClientErrorException("Permission ownership cannot change", 409);
      if (ownedRoles.contains(item.name) || (role != null && role.getFirstAttribute(OWNER) != null
          && !item.owner.equals(role.getFirstAttribute(OWNER)) && !migrating))
        throw new ClientErrorException("Permission ownership conflicts with an existing role", 409);
      if (role != null && (role.isComposite() || (previous != null && !previousPermissions.contains(item.name)
          && !item.owner.equals(role.getFirstAttribute(OWNER)))))
        throw new ClientErrorException("Permission conflicts with an existing role", 409);
    }
    for (var item : value.roles) {
      if (previousPermissions.contains(item.name))
        throw new ClientErrorException("Permission cannot become an ordinary role", 409);
      var existing = realm.getRole(item.name);
      if (previous != null && existing != null && !ADMIN.equals(item.name) && !ownedRoles.contains(item.name))
        throw new ClientErrorException("Role conflicts with an unmanaged role", 409);
    }
    for (var group : value.groups) findGroup(realm, group.name);
  }

  static Set<String> ownedRoles(RealmModel realm) {
    String encoded = realm.getAttribute(OWNED_ROLES);
    if (encoded == null) return new HashSet<>();
    try { return new HashSet<>(Arrays.asList(JsonSerialization.readValue(encoded, String[].class))); }
    catch (Exception error) { throw new ServiceUnavailableException("Invalid stored role ownership"); }
  }

  static RoleModel ensureRole(RealmModel realm, String name) {
    var role = realm.getRole(name);
    return role != null ? role : realm.addRole(name);
  }
  static void clear(RoleModel role) {
    if (role != null) for (var composite : role.getCompositesStream().toList()) role.removeCompositeRole(composite);
  }

  static void reconcile(RealmModel realm, Registry value, Registry previous) {
    if (value.accessRules != null) for (var rule : value.accessRules) {
      var client = realm.getClientByClientId(rule.clientId);
      if (client != null && ApplicationsResourceFactory.managed(client))
        throw new ClientErrorException("Manage this application's access permissions from Applications.", 409);
    }
    if (value.clientTokenScopes != null) for (var scope : value.clientTokenScopes) {
      var client = realm.getClientByClientId(scope.clientId);
      if (client != null && ApplicationsResourceFactory.managed(client))
        throw new ClientErrorException("Managed application token scopes belong to Applications.", 409);
    }
    // Validate every managed application against the proposed permissions before any mutation.
    // Never remove an admission requirement or break its native token scope implicitly.
    ApplicationsResourceFactory.views(realm, value);
    ClientAccessRules.preflight(realm, value.accessRules);
    var owned = ownedRoles(realm);
    var activePermissions = new HashSet<String>();
    for (var item : value.permissions) {
      activePermissions.add(item.name);
      var role = ensureRole(realm, item.name);
      role.setDescription(item.description);
      role.setSingleAttribute(OWNER, item.owner);
    }
    for (var item : value.roles) {
      if (ADMIN.equals(item.name)) continue;
      owned.add(item.name);
      var role = ensureRole(realm, item.name);
      role.setDescription(item.description);
      role.setSingleAttribute(OWNER, REGISTRY_OWNER);
    }
    // Keep retired ordinary roles and their IDs/memberships, but grant no effective permission.
    for (String name : owned) clear(realm.getRole(name));
    for (var item : value.roles) {
      if (ADMIN.equals(item.name)) continue;
      var role = realm.getRole(item.name);
      for (String permission : item.permissions) role.addCompositeRole(realm.getRole(permission));
    }
    var administrator = ensureRole(realm, ADMIN);
    administrator.setDescription("All active permissions in this environment. Managed automatically.");
    administrator.setSingleAttribute(OWNER, REGISTRY_OWNER);
    clear(administrator);
    for (String permission : activePermissions) administrator.addCompositeRole(realm.getRole(permission));

    // Only previous registry grants are ours. Preserve all other grants and all memberships.
    if (previous != null) for (var item : previous.groups) {
      var group = findGroup(realm, item.name);
      if (group != null) for (String name : item.roles) {
        var role = realm.getRole(name);
        if (role != null) group.deleteRoleMapping(role);
      }
    }
    for (var item : value.groups) {
      var group = findGroup(realm, item.name);
      if (group == null) group = realm.createGroup(item.name);
      for (String name : item.roles) group.grantRole(realm.getRole(name));
    }
    if (previous != null) for (var item : previous.permissions)
      if (!activePermissions.contains(item.name)) {
        var role = realm.getRole(item.name);
        if (role != null && item.owner.equals(role.getFirstAttribute(OWNER))) realm.removeRole(role);
      }
    ClientTokenScopes.reconcile(realm, value.clientTokenScopes,
        previous == null ? null : previous.clientTokenScopes);
    ClientAccessRules.reconcile(realm, value.accessRules);
    realm.setAttribute(OWNED_ROLES, serialize(new TreeSet<>(owned)));
  }

  static GroupModel findGroup(RealmModel realm, String name) {
    var matches = realm.getTopLevelGroupsStream().filter(group -> name.equals(group.getName())).toList();
    if (matches.size() > 1) throw new ClientErrorException("Ambiguous group name", 409);
    return matches.isEmpty() ? null : matches.get(0);
  }
}
