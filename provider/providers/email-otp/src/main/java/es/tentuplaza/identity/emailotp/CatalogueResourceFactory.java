package es.tentuplaza.identity.emailotp;

import jakarta.ws.rs.*;
import jakarta.ws.rs.core.Response;
import jakarta.persistence.EntityManager;
import java.time.Instant;
import java.util.*;
import org.keycloak.Config;
import org.keycloak.connections.jpa.JpaConnectionProvider;
import org.keycloak.models.*;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.services.resource.*;
import org.keycloak.util.JsonSerialization;

/** Private service API; authorization and history share Keycloak's database transaction. */
public final class CatalogueResourceFactory implements RealmResourceProviderFactory {
  public String getId() { return "score-catalogue"; }
  public RealmResourceProvider create(KeycloakSession session) {
    return new RealmResourceProvider() {
      public Object getResource() { return new Resource(session); }
      public void close() { }
    };
  }
  public void init(Config.Scope config) { }
  public void postInit(KeycloakSessionFactory factory) { }
  public void close() { }

  public static final class Change {
    public String baseRevision;
    public AuthorizationResourceFactory.Registry registry;
    public List<String> roleNames;
    public String actor;
    public String reason;
    public String type;
  }
  public static final class Initialization {
    public String baseRevision;
    public List<String> roleNames;
    public List<Historical> history = new ArrayList<>();
  }
  public static final class Historical {
    public String id;
    public String createdAt;
    public String actor;
    public String reason;
    public String type;
    public Map<String,Object> catalogue;
  }
  static Map<String,Object> project(AuthorizationResourceFactory.Registry registry, List<String> selected) {
    if (selected == null || selected.size() > 250 || new HashSet<>(selected).size() != selected.size()
        || !selected.containsAll(List.of("administrador", "member"))) throw new BadRequestException("Invalid catalogue roles");
    var names = new HashSet<String>();
    for (var role : registry.roles) names.add(role.name);
    if (!names.containsAll(selected)) throw new BadRequestException("Unknown catalogue role");
    var byName = new HashMap<String, AuthorizationResourceFactory.Role>();
    for (var role : registry.roles) {
      byName.put(role.name, role);
      if (!selected.contains(role.name) && !role.permissions.isEmpty()) throw new BadRequestException("Retired roles must have no grants");
      if (selected.contains(role.name)) for (String reference : role.permissions)
        if (names.contains(reference) && !selected.contains(reference)) throw new BadRequestException("Active roles cannot inherit retired roles");
    }
    for (var group : registry.groups) if (!selected.containsAll(group.roles)) throw new BadRequestException("A group references a retired role");
    var atoms = new HashSet<String>();
    for (var permission : registry.permissions) atoms.add(permission.name);
    String defaultRole = registry.defaultRole == null ? RegistrationPolicy.MEMBER : registry.defaultRole;
    if (!selected.contains(defaultRole)) throw new BadRequestException("The registration default role must be active");
    var pending = new ArrayDeque<String>(); pending.add(defaultRole);
    var visited = new HashSet<String>();
    while (!pending.isEmpty()) {
      String name = pending.removeFirst(); if (!visited.add(name)) continue;
      var role = byName.get(name);
      if (role == null || "administrador".equals(name))
        throw new BadRequestException("The registration role can only grant explicit application access permissions");
      for (String reference : role.permissions) {
        if (defaultRole.equals(name) && atoms.contains(reference)
            && RegistrationPolicy.isDefaultApplicationAccess(reference)) continue;
        pending.add(reference);
      }
    }
    var roles = registry.roles.stream().filter(role -> selected.contains(role.name)).map(role ->
        Map.of("name", role.name, "description", Objects.toString(role.description, ""), "permissions", role.permissions)).toList();
    var permissions = registry.permissions.stream().map(permission ->
        Map.of("name", permission.name, "description", Objects.toString(permission.description, ""))).toList();
    var groups = registry.groups.stream().map(group -> Map.of("name", group.name, "roles", group.roles)).toList();
    return Map.of("defaultRole", defaultRole, "permissions", permissions, "roles", roles,
        "groups", groups, "accessRules", registry.accessRules == null ? List.of() : registry.accessRules);
  }
  static Map<String,Object> operation(CatalogueRevisionEntity entry) {
    return Map.of("id", entry.id, "createdAt", Instant.ofEpochMilli(entry.createdAt).toString(),
        "actor", entry.actor, "reason", entry.reason, "type", entry.operation,
        "environments", List.of(entry.environment), "revisions", Map.of(entry.environment, entry.id));
  }
  public static final class Resource {
    private final KeycloakSession session;
    Resource(KeycloakSession session) { this.session = session; }
    private RealmModel realm() { return session.getContext().getRealm(); }
    private EntityManager em() { return session.getProvider(JpaConnectionProvider.class).getEntityManager(); }
    private void authorize(Set<String> allowed) {
      var auth = new AppAuthManager.BearerTokenAuthenticator(session).setAudience("identity-provider").authenticate();
      if (auth == null || auth.getUser() == null || auth.getClient() == null) throw new NotAuthorizedException("Bearer");
      var client = auth.getClient();
      if (!allowed.contains(client.getClientId()) || !client.getClientId().equals(auth.getToken().getIssuedFor())
          || !client.isEnabled() || client.isPublicClient() || !client.isServiceAccountsEnabled()
          || !auth.getUser().isEnabled() || !client.getId().equals(auth.getUser().getServiceAccountClientLink()))
        throw new ForbiddenException("Dedicated catalogue service account required");
    }
    private AuthorizationResourceFactory.Registry active() {
      var registry = AuthorizationResourceFactory.read(realm());
      if (registry == null) throw new ServiceUnavailableException("Authorization registry is not initialized");
      return registry;
    }
    @SuppressWarnings("unchecked") private Map<String,Object> catalogue(AuthorizationResourceFactory.Registry registry) {
      var entry = em().find(CatalogueRevisionEntity.class, registry.revision);
      if (entry != null && realm().getId().equals(entry.realmId)) {
        try { return JsonSerialization.readValue(entry.catalogue, Map.class); }
        catch (Exception error) { throw new ServiceUnavailableException("Invalid stored catalogue"); }
      }
      return project(registry, registry.roles.stream().map(role -> role.name).toList());
    }
    private Response response(Object body) { return Response.ok(body).header("Cache-Control", "no-store").build(); }
    @GET @Produces("application/json") public Response get() {
      authorize(Set.of("identity-admin-service", "identity-config-sync"));
      var registry = active();
      var entry = em().find(CatalogueRevisionEntity.class, registry.revision);
      return response(Map.of("registry", registry, "catalogue", catalogue(registry), "initialized", entry != null && realm().getId().equals(entry.realmId)));
    }
    @GET @Path("projection") @Produces("application/json") public Response projection() {
      authorize(Set.of("identity-admin-service", "identity-account-service", "identity-config-sync"));
      var registry = active();
      var roles = (List<?>) catalogue(registry).get("roles");
      return response(Map.of("permissions", registry.permissions.stream().map(permission -> permission.name).toList(),
          "roles", roles.stream().map(role -> ((Map<?,?>) role).get("name")).toList()));
    }
    @GET @Path("revisions") @Produces("application/json") public Response revisions() {
      authorize(Set.of("identity-admin-service"));
      return response(em().createQuery("select e from CatalogueRevisionEntity e where e.realmId = :realm order by e.createdAt desc, e.id desc", CatalogueRevisionEntity.class)
          .setParameter("realm", realm().getId()).setMaxResults(100).getResultList().stream().map(CatalogueResourceFactory::operation).toList());
    }
    @GET @Path("revisions/{id}") @Produces("application/json") public Response revision(@PathParam("id") String id) {
      authorize(Set.of("identity-admin-service"));
      if (!id.matches("[a-f0-9]{64}")) throw new BadRequestException("Invalid revision");
      var entry = em().find(CatalogueRevisionEntity.class, id);
      if (entry == null || !realm().getId().equals(entry.realmId)) throw new NotFoundException();
      try { return response(Map.of("operation", operation(entry), "catalogue", JsonSerialization.readValue(entry.catalogue, Map.class))); }
      catch (java.io.IOException error) { throw new ServiceUnavailableException("Invalid stored catalogue"); }
    }
    @POST @Path("initialize") @Consumes("application/json") @Produces("application/json") public Response initialize(Initialization input) {
      authorize(Set.of("identity-config-sync"));
      AuthorizationResourceFactory.acquire(session, realm());
      try {
      var registry = active();
      var existing = em().find(CatalogueRevisionEntity.class, registry.revision);
      if (existing != null && realm().getId().equals(existing.realmId)) { realm().setAttribute("score.catalogue.database-managed", "true"); return response(Map.of("initialized", true)); }
      if (input == null || !registry.revision.equals(input.baseRevision)) throw new ClientErrorException("Stale bootstrap revision", 409);
      if (input.history == null || input.history.size() > 100) throw new BadRequestException("Invalid migration history");
      var current = project(registry, input.roleNames);
      for (var item : input.history) {
        if (item.id == null || !item.id.matches("[a-f0-9]{64}") || item.catalogue == null) throw new BadRequestException("Invalid migration revision");
        if (em().find(CatalogueRevisionEntity.class, item.id) == null)
          persist(item.id, registry.environment, item.actor, item.reason, item.type, Instant.parse(item.createdAt).toEpochMilli(), item.catalogue);
      }
      if (em().find(CatalogueRevisionEntity.class, registry.revision) == null)
        persist(registry.revision, registry.environment, "system", "Initialize database catalogue", "publish", System.currentTimeMillis(), current);
      realm().setAttribute("score.catalogue.database-managed", "true");
      return response(Map.of("initialized", true));
      } catch (RuntimeException error) { session.getTransactionManager().setRollbackOnly(); throw error; }
    }
    @POST @Consumes("application/json") @Produces("application/json") public Response save(Change input) {
      authorize(Set.of("identity-admin-service"));
      AuthorizationResourceFactory.acquire(session, realm());
      var previous = active();
      if (input == null || !previous.revision.equals(input.baseRevision)) throw new ClientErrorException("The catalogue has changed. Reload before saving.", 409);
      var registry = input.registry;
      AuthorizationResourceFactory.validate(registry);
      if (registry.defaultRole == null) registry.defaultRole = previous.defaultRole;
      if (!previous.environment.equals(registry.environment) || registry.generation != previous.generation + 1
          || registry.revision.equals(previous.revision) || !registry.revision.matches("[a-f0-9]{64}")) throw new ClientErrorException("Invalid catalogue generation", 409);
      if (em().find(CatalogueRevisionEntity.class, registry.revision) != null) throw new ClientErrorException("Catalogue revision already exists", 409);
      var projected = project(registry, input.roleNames);
      AuthorizationResourceFactory.validateOwnership(realm(), registry, previous);
      try {
        AuthorizationResourceFactory.reconcile(realm(), registry, previous);
        realm().setAttribute(AuthorizationResourceFactory.ACTIVE, AuthorizationResourceFactory.serialize(registry));
        realm().setAttribute("score.catalogue.database-managed", "true");
        var entry = persist(registry.revision, registry.environment, input.actor, input.reason, input.type, System.currentTimeMillis(), projected);
        return response(operation(entry));
      } catch (RuntimeException error) { session.getTransactionManager().setRollbackOnly(); throw error; }
    }
    private CatalogueRevisionEntity persist(String id, String environment, String actor, String reason, String type, long time, Map<String,Object> catalogue) {
      if (actor == null || actor.isBlank() || actor.length() > 200 || reason == null || reason.trim().length() < 8
          || reason.length() > 300 || !Set.of("publish", "rollback").contains(type)) throw new BadRequestException("Invalid catalogue audit record");
      var entry = new CatalogueRevisionEntity(); entry.id = id; entry.realmId = realm().getId(); entry.environment = environment;
      entry.createdAt = time; entry.actor = actor; entry.reason = reason; entry.operation = type;
      entry.catalogue = AuthorizationResourceFactory.serialize(catalogue); em().persist(entry); return entry;
    }
  }
}
