package es.tentuplaza.identity.emailotp;

import jakarta.ws.rs.BadRequestException;
import jakarta.ws.rs.ClientErrorException;
import jakarta.ws.rs.ForbiddenException;
import java.net.URI;
import java.util.*;
import org.keycloak.models.*;

/** OIDC client admission only; applications still authorize their own resources. */
final class ClientAccessRules {
  static final String OWNED_PREFIX = "score-access-rule-";
  private static final String OIDC = "openid-connect";
  private static final Set<String> PROTECTED = Set.of("account", "account-console", "admin-cli",
      "security-admin-console", "realm-management", "broker");

  public static final class Rule {
    public String id;
    public String clientId;
    public String origin;
    public List<String> requiredPermissions = new ArrayList<>();
  }

  private static boolean name(String value) {
    return value != null && value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,159}");
  }

  private static boolean protectedClient(String value) {
    if (value == null) return true;
    String normalized = value.toLowerCase(Locale.ROOT);
    return PROTECTED.contains(normalized) || normalized.startsWith("identity-");
  }

  static void validate(List<Rule> rules, Set<String> activePermissions, String environment) {
    if (rules == null) return;
    if (rules.size() > 250) throw new BadRequestException("Too many client access rules.");
    var ids = new HashSet<String>();
    var clients = new HashSet<String>();
    for (var rule : rules) {
      if (rule == null || !name(rule.id) || !ids.add(rule.id) || !name(rule.clientId)
          || protectedClient(rule.clientId) || !clients.add(rule.clientId)
          || rule.requiredPermissions == null || rule.requiredPermissions.isEmpty()
          || rule.requiredPermissions.size() > 1000)
        throw new BadRequestException("Invalid, duplicate or protected client access rule.");
      if (!canonicalOrigin(rule.origin, environment).equals(rule.origin))
        throw new BadRequestException("Use a canonical access-rule origin without a default port or path.");
      var permissions = new HashSet<String>();
      for (String permission : rule.requiredPermissions)
        if (permission == null || permission.length() > 160
            || !permission.matches("[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9._-]+)+")
            || activePermissions == null || !activePermissions.contains(permission)
            || !permissions.add(permission))
          throw new BadRequestException("Access rules require unique active atomic permissions.");
    }
  }

  /** The registry stores an origin, never a URL prefix or wildcard expression. */
  static String canonicalOrigin(String value, String environment) {
    return origin(value, "local".equals(environment), true);
  }

  private static String origin(String value, boolean local, boolean originOnly) {
    try {
      if (value == null || value.length() > 2048 || value.contains("*") || value.contains("\\"))
        throw new IllegalArgumentException();
      var uri = URI.create(value);
      String scheme = uri.getScheme();
      String host = uri.getHost();
      if (!uri.isAbsolute() || uri.isOpaque() || scheme == null || host == null
          || uri.getRawUserInfo() != null || uri.getRawFragment() != null
          || (originOnly && (uri.getRawQuery() != null
              || (uri.getRawPath() != null && !uri.getRawPath().isEmpty()))))
        throw new IllegalArgumentException();
      scheme = scheme.toLowerCase(Locale.ROOT);
      host = host.toLowerCase(Locale.ROOT);
      boolean loopback = Set.of("localhost", "127.0.0.1", "[::1]", "::1").contains(host);
      if (!("https".equals(scheme) || (local && loopback && "http".equals(scheme)))
          || host.endsWith(".") || host.length() > 253)
        throw new IllegalArgumentException();
      int port = uri.getPort();
      if (port == 0 || port > 65535 || port < -1) throw new IllegalArgumentException();
      String authority = host + (port == -1 ? "" : ":" + port);
      if (!authority.equalsIgnoreCase(uri.getRawAuthority())) throw new IllegalArgumentException();
      int defaultPort = "https".equals(scheme) ? 443 : 80;
      return scheme + "://" + host + (port == -1 || port == defaultPort ? "" : ":" + port);
    } catch (IllegalArgumentException error) {
      throw new BadRequestException("Use an exact HTTPS origin; HTTP loopback is allowed only locally.");
    }
  }

  private record Prepared(ClientModel client, List<ProtocolMapperModel> mappers) { }

  private static ClientErrorException conflict(String message) {
    return new ClientErrorException(message, 409);
  }

  private static ProtocolMapperModel mapper(String suffix, String provider, Map<String, String> config) {
    var mapper = new ProtocolMapperModel();
    mapper.setName(OWNED_PREFIX + suffix);
    mapper.setProtocol(OIDC);
    mapper.setProtocolMapper(provider);
    mapper.setConfig(new HashMap<>(config));
    return mapper;
  }

  private static boolean equivalent(ProtocolMapperModel actual, ProtocolMapperModel expected) {
    var config = actual.getConfig() == null ? Map.<String, String>of() : actual.getConfig();
    String rolePrefix = config.get("usermodel.realmRoleMapping.rolePrefix");
    return OIDC.equals(actual.getProtocol()) && expected.getProtocolMapper().equals(actual.getProtocolMapper())
        && expected.getConfig().entrySet().stream()
            .allMatch(entry -> entry.getValue().equals(config.get(entry.getKey())))
        && (!"oidc-usermodel-realm-role-mapper".equals(expected.getProtocolMapper())
            || rolePrefix == null || rolePrefix.isEmpty());
  }

  private static List<Prepared> prepare(RealmModel realm, List<Rule> rules) {
    if (rules == null) return List.of();
    var declared = new HashSet<String>();
    for (var rule : rules)
      if (rule != null && rule.requiredPermissions != null) declared.addAll(rule.requiredPermissions);
    // The caller validates actual ownership and environment against the proposed registry.
    // Repeat structural bounds here so direct preflight/reconcile calls cannot bypass them.
    validate(rules, declared, "local");
    var clients = new HashSet<String>();
    var prepared = new ArrayList<Prepared>();
    for (var rule : rules) {
      if (rule == null || !name(rule.clientId) || protectedClient(rule.clientId) || !clients.add(rule.clientId))
        throw conflict("Access rules require distinct non-protected clients.");
      var client = realm.getClientByClientId(rule.clientId);
      if (client == null || !client.isEnabled() || !OIDC.equals(client.getProtocol())
          || !client.isStandardFlowEnabled() || client.isServiceAccountsEnabled())
        throw conflict("Access rules require an existing enabled OIDC authorization-code client without service accounts.");
      ClientTokenScopes.preflightRuleClient(client);
      // Locality is validated against the proposed registry environment by validate().
      String expected = canonicalOrigin(rule.origin, "local");
      if (!expected.equals(rule.origin) || client.getRedirectUris() == null || client.getRedirectUris().isEmpty())
        throw conflict("Access rules require a canonical origin and registered absolute callbacks.");
      for (String redirect : client.getRedirectUris()) {
        try {
          if (!expected.equals(origin(redirect, true, false)))
            throw conflict("Every registered callback must use the single access-rule origin.");
        } catch (BadRequestException error) {
          throw conflict("Access-rule callbacks must be absolute URLs without wildcards, credentials or fragments.");
        }
      }
      var expectedMappers = List.of(
          mapper("authentication-policy", "tentu-authentication-policy", Map.of()),
          mapper("realm-roles", "oidc-usermodel-realm-role-mapper", Map.of(
              "access.token.claim", "true", "claim.name", "realm_access.roles",
              "jsonType.label", "String", "multivalued", "true")),
          mapper("client-audience", "oidc-audience-mapper", Map.of(
              "included.custom.audience", rule.clientId, "access.token.claim", "true", "id.token.claim", "false")));
      var existing = client.getProtocolMappersStream().toList();
      var additions = new ArrayList<ProtocolMapperModel>();
      for (var desired : expectedMappers) {
        var named = existing.stream().filter(item -> desired.getName().equals(item.getName())).toList();
        if (named.size() > 1 || (!named.isEmpty() && !equivalent(named.getFirst(), desired)))
          throw conflict("An access-rule mapper name conflicts with an existing mapper.");
        if (existing.stream().noneMatch(item -> equivalent(item, desired))) additions.add(desired);
      }
      prepared.add(new Prepared(client, additions));
    }
    return prepared;
  }

  static void preflight(RealmModel realm, List<Rule> rules) {
    prepare(realm, rules);
  }

  static void reconcile(RealmModel realm, List<Rule> rules) {
    // No mutations occur until every callback, client and mapper has passed preflight.
    for (var change : prepare(realm, rules))
      change.mappers.forEach(change.client::addProtocolMapper);
  }

  static void enforce(RealmModel realm, UserModel user, ClientModel client, String redirectUri) {
    var registry = AuthorizationResourceFactory.read(realm);
    if (client == null || client.getClientId() == null) {
      if ((registry != null && registry.accessRules != null && !registry.accessRules.isEmpty())
          || realm.getClientsStream().anyMatch(ApplicationsResourceFactory::managed))
        throw new ForbiddenException("The OIDC client context is required for access verification.");
      return;
    }
    boolean managedApplication = ApplicationsResourceFactory.managed(client);
    if (registry == null) {
      if (managedApplication) throw new ForbiddenException("The current application policy is unavailable.");
      return;
    }
    var matching = new ArrayList<Rule>();
    if (registry.accessRules != null) registry.accessRules.stream()
        .filter(rule -> rule != null && client.getClientId().equals(rule.clientId)).forEach(matching::add);
    if (managedApplication) {
      try { matching.add(ApplicationsResourceFactory.rule(client, registry)); }
      catch (RuntimeException invalid) { throw new ForbiddenException("The current application policy is invalid."); }
    }
    if (matching.isEmpty()) return;
    if (matching.size() != 1 || user == null || !user.isEnabled() || user.getServiceAccountClientLink() != null
        || !client.isEnabled() || !OIDC.equals(client.getProtocol()) || !client.isStandardFlowEnabled()
        || client.isServiceAccountsEnabled())
      throw new ForbiddenException("A current signed-in user and eligible OIDC client are required.");
    var rule = matching.getFirst();
    try {
      validate(List.of(rule), registry.permissions.stream().map(permission -> permission.name).collect(java.util.stream.Collectors.toSet()), registry.environment);
      if (!rule.origin.equals(origin(redirectUri, "local".equals(registry.environment), false)))
        throw new ForbiddenException("The callback origin is not permitted for this client.");
    } catch (BadRequestException error) {
      throw new ForbiddenException("The callback and applied access rule must contain a valid exact origin.");
    }
    for (String permission : rule.requiredPermissions) {
      var role = realm.getRole(permission);
      if (role == null || role.isClientRole() || role.isComposite() || !user.hasRole(role))
        throw new ForbiddenException("Your current permissions do not allow access to this application.");
    }
  }
}
