package es.tentuplaza.identity.emailotp;

import jakarta.ws.rs.BadRequestException;
import jakarta.ws.rs.ClientErrorException;
import java.util.*;
import org.keycloak.models.*;
import org.keycloak.util.JsonSerialization;

/** Restricts token roles without changing user grants or claiming unrelated scope mappings. */
final class ClientTokenScopes {
  static final String OWNED = "tentu.authorization.token-scope";
  private static final Set<String> PROTECTED = Set.of("account", "account-console", "admin-cli",
      "security-admin-console", "identity-config-sync", "identity-admin-service");
  private static final Set<String> TECHNICAL = Set.of("offline_access", "uma_authorization");

  public static final class Scope {
    public String clientId;
    public boolean enabled = true;
    public List<String> permissions = new ArrayList<>();
  }

  static void validate(List<Scope> scopes, Set<String> activePermissions) {
    if (scopes == null) return; // Old snapshots do not own this configuration.
    if (scopes.size() > 2000) throw new BadRequestException("Too many client token scopes");
    var clients = new HashSet<String>();
    for (var scope : scopes) {
      if (scope == null || scope.clientId == null
          || !scope.clientId.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,159}")
          || PROTECTED.contains(scope.clientId) || !clients.add(scope.clientId)
          || scope.permissions == null || scope.permissions.size() > 10000
          || (!scope.enabled && !scope.permissions.isEmpty()))
        throw new BadRequestException("Invalid or protected client token scope");
      var unique = new HashSet<String>();
      for (String permission : scope.permissions)
        if (!atomicName(permission) || !activePermissions.contains(permission) || !unique.add(permission))
          throw new BadRequestException("Unknown or duplicate client token permission");
    }
  }

  private static boolean atomicName(String name) {
    return name != null && name.matches("[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9._-]+)+")
        && name.length() <= 160;
  }

  private static ClientErrorException conflict(String message) {
    return new ClientErrorException(message, 409);
  }

  private static Set<String> owned(String encoded) {
    if (encoded == null) return Set.of();
    try {
      var names = JsonSerialization.readValue(encoded, String[].class);
      if (names == null || names.length > 10000) throw new IllegalArgumentException();
      var result = new HashSet<String>();
      for (String name : names)
        if (!atomicName(name) || !result.add(name)) throw new IllegalArgumentException();
      return result;
    } catch (Exception error) {
      throw conflict("Invalid managed client token scope attribute");
    }
  }

  private static boolean allowed(RoleModel role, Set<String> desired) {
    return role != null && !role.isClientRole() && !role.isComposite()
        && (desired.contains(role.getName()) || TECHNICAL.contains(role.getName()));
  }

  /** Rule-managed scopes must remain removable without claiming manual grants. */
  static void preflightRuleClient(ClientModel client) {
    if (client == null) throw conflict("Access rules require a dedicated existing client.");
    var managed = owned(client.getAttribute(OWNED));
    if (client.getScopeMappingsStream().anyMatch(role -> !allowed(role, managed)))
      throw conflict("Access rules require a dedicated clean client without manually scoped permissions.");
    for (boolean defaults : List.of(true, false))
      for (var linked : client.getClientScopes(defaults).values())
        if (linked.getScopeMappingsStream().anyMatch(role -> !allowed(role, Set.of())))
          throw conflict("Access rules require a dedicated clean client without permissions inherited from linked scopes.");
  }

  private record Prepared(ClientModel client, boolean enabled, List<RoleModel> remove,
                          List<RoleModel> add, String owned) { }

  static void reconcile(RealmModel realm, List<Scope> scopes, List<Scope> previous) {
    if (scopes == null) return;
    var requested = new HashSet<String>();
    for (var scope : scopes) if (scope != null && scope.permissions != null) requested.addAll(scope.permissions);
    validate(scopes, requested);
    var prepared = new ArrayList<Prepared>();
    // Preflight every client before any mutation; the enclosing registry also provides rollback.
    for (var scope : scopes) {
      var client = realm.getClientByClientId(scope.clientId);
      if (client == null) throw conflict("Client token scope references an unknown client");
      String encoded = client.getAttribute(OWNED);
      var oldOwned = owned(encoded);
      var mappings = client.getScopeMappingsStream().toList();
      var remove = new ArrayList<RoleModel>();
      if (!scope.enabled) {
        boolean alreadyDisabled = previous != null && previous.stream().anyMatch(old ->
            old != null && scope.clientId.equals(old.clientId) && !old.enabled);
        if (encoded == null && !alreadyDisabled)
          throw conflict("Cannot restore an unmanaged client token scope");
        for (var role : mappings)
          if (!role.isClientRole() && oldOwned.contains(role.getName())) remove.add(role);
        prepared.add(new Prepared(client, false, remove, List.of(), null));
        continue;
      }
      var desired = new HashSet<>(scope.permissions);
      var roles = new LinkedHashMap<String, RoleModel>();
      for (String permission : new TreeSet<>(desired)) {
        var role = realm.getRole(permission);
        if (role == null || role.isClientRole() || role.isComposite())
          throw conflict("Client token scope requires an existing atomic realm permission");
        roles.put(permission, role);
      }
      var nextOwned = new TreeSet<String>();
      var existing = new HashSet<String>();
      for (var role : mappings) {
        if (!role.isClientRole() && oldOwned.contains(role.getName())) {
          if (!desired.contains(role.getName())) remove.add(role);
          else {
            if (!allowed(role, desired)) throw conflict("Managed token permission is no longer atomic");
            nextOwned.add(role.getName());
            existing.add(role.getName());
          }
        } else {
          if (!allowed(role, desired)) throw conflict("Unmanaged client scope mapping widens token permissions");
          existing.add(role.getName());
        }
      }
      for (boolean defaults : List.of(true, false))
        for (var linked : client.getClientScopes(defaults).values())
          if (linked.getScopeMappingsStream().anyMatch(role -> !allowed(role, desired)))
            throw conflict("Linked client scope widens token permissions");
      var add = new ArrayList<RoleModel>();
      roles.forEach((name, role) -> {
        if (!existing.contains(name)) {
          add.add(role);
          nextOwned.add(name);
        }
      });
      String nextEncoded;
      try { nextEncoded = JsonSerialization.writeValueAsString(nextOwned); }
      catch (Exception error) { throw conflict("Cannot encode managed client token scope"); }
      prepared.add(new Prepared(client, true, remove, add, nextEncoded));
    }
    for (var change : prepared) {
      change.remove.forEach(change.client::deleteScopeMapping);
      change.add.forEach(change.client::addScopeMapping);
      change.client.setFullScopeAllowed(!change.enabled);
      if (change.enabled) change.client.setAttribute(OWNED, change.owned);
      else change.client.removeAttribute(OWNED);
    }
  }
}
