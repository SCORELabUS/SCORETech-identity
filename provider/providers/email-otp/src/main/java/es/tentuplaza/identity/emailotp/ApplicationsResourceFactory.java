package es.tentuplaza.identity.emailotp;

import jakarta.ws.rs.*;
import jakarta.ws.rs.core.Response;
import java.net.URI;
import java.util.*;
import java.util.function.Supplier;
import org.keycloak.Config;
import org.keycloak.models.*;
import org.keycloak.models.utils.KeycloakModelUtils;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.services.managers.ClientManager;
import org.keycloak.services.managers.RealmManager;
import org.keycloak.services.managers.AuthenticationManager.AuthResult;
import org.keycloak.services.resource.*;
import org.keycloak.util.JsonSerialization;

/** Native, transaction-bound OIDC application management. Secrets never enter the registry. */
public final class ApplicationsResourceFactory implements RealmResourceProviderFactory {
  static final String MANAGED = "score.application.managed";
  static final String CONFIG = "score.application.configuration";
  static final String PREFIX = "score-app-";
  private static final String OIDC = "openid-connect";
  private static final String LOGOUT = "post.logout.redirect.uris";
  private static final Set<String> FIELDS = Set.of("name", "kind", "origin", "redirectUris",
      "postLogoutRedirectUris", "requiredPermissions", "enabled");

  public String getId() { return "score-applications"; }
  public RealmResourceProvider create(KeycloakSession session) {
    return new RealmResourceProvider() {
      public Object getResource() { return new Resource(session); }
      public void close() { }
    };
  }
  public void init(Config.Scope config) { }
  public void postInit(KeycloakSessionFactory factory) { }
  public void close() { }

  public static final class Configuration {
    public String name;
    public String kind;
    public String origin;
    public List<String> redirectUris;
    public List<String> postLogoutRedirectUris;
    public List<String> requiredPermissions;
    public boolean enabled;
    public String version;
  }

  static ClientErrorException conflict(String message) { return new ClientErrorException(message, 409); }

  static boolean managed(ClientModel client) {
    return client != null && client.getAttribute(MANAGED) != null;
  }

  static void authorize(RealmModel realm, AuthResult auth) {
    if (auth == null || auth.getUser() == null || auth.getSession() == null || auth.getToken() == null
        || auth.getClient() == null) throw new NotAuthorizedException("Bearer");
    var user = auth.getUser();
    var administrator = realm.getRole("administrador");
    if (!user.isEnabled() || user.getServiceAccountClientLink() != null || !auth.getClient().isEnabled()
        || auth.getSession().getState() != UserSessionModel.State.LOGGED_IN || auth.getSession().getUser() == null
        || !Objects.equals(user.getId(), auth.getSession().getUser().getId())
        || auth.getToken().getAudience() == null || Arrays.stream(auth.getToken().getAudience()).noneMatch("identity-admin-api"::equals)
        || !"identity-admin-web".equals(auth.getClient().getClientId())
        || auth.getClient().isServiceAccountsEnabled() || administrator == null || !user.hasRole(administrator)
        || !AuthenticationPolicy.hasPasskey(user)
        || !"true".equals(auth.getSession().getNote(AuthenticationPolicy.ADMIN))
        || !AuthenticationPolicy.PASSKEY.equals(auth.getSession().getNote(AuthenticationPolicy.METHOD))
        || !AuthenticationPolicy.PASSKEY.equals(auth.getToken().getOtherClaims().get("tentu_auth_method"))
        || !Boolean.TRUE.equals(auth.getToken().getOtherClaims().get("tentu_admin_verified")))
      throw new ForbiddenException("A current identity administrator with verified passkey authentication is required.");
    SupportResourceFactory.requireAuthorization(realm, auth, "identity:roles:manage", false);
  }

  private static String text(Map<String, Object> input, String field, int maximum) {
    if (!(input.get(field) instanceof String value) || value.isBlank() || value.length() > maximum
        || !value.equals(value.trim()) || value.chars().anyMatch(Character::isISOControl))
      throw new BadRequestException("Invalid application " + field + ".");
    return value;
  }

  private static String version(Map<String, Object> input) {
    String value = text(input, "version", 36);
    if (!value.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))
      throw new BadRequestException("A valid current application version is required.");
    return value;
  }

  private static List<String> strings(Map<String, Object> input, String field, int minimum, int maximum) {
    if (!(input.get(field) instanceof List<?> values) || values.size() < minimum || values.size() > maximum)
      throw new BadRequestException("Invalid application " + field + ".");
    var result = new ArrayList<String>();
    for (Object entry : values) {
      if (!(entry instanceof String value) || value.isBlank() || value.length() > 2048 || result.contains(value))
        throw new BadRequestException("Application lists require unique valid strings.");
      result.add(value);
    }
    return result;
  }

  private static void callback(String value, String expected, String environment) {
    try {
      var uri = URI.create(value);
      if (!uri.isAbsolute() || uri.isOpaque() || uri.getHost() == null || uri.getRawUserInfo() != null
          || uri.getRawFragment() != null || value.contains("*") || value.contains("\\")
          || !expected.equals(ClientAccessRules.canonicalOrigin(uri.getScheme() + "://" + uri.getRawAuthority(), environment)))
        throw new IllegalArgumentException();
    } catch (IllegalArgumentException error) {
      throw new BadRequestException("Every callback must be an absolute URL on the exact application origin, without wildcards, credentials or fragments.");
    }
  }

  static Configuration validate(Map<String, Object> input, AuthorizationResourceFactory.Registry registry, boolean update) {
    var allowed = new HashSet<>(FIELDS);
    if (update) allowed.add("version");
    if (input == null || !allowed.equals(input.keySet()) || registry == null || registry.permissions == null
        || !(input.get("enabled") instanceof Boolean))
      throw new BadRequestException("Provide only the complete application configuration and its current version when updating.");
    var value = new Configuration();
    value.name = text(input, "name", 150);
    value.kind = text(input, "kind", 20);
    if (!Set.of("public", "confidential").contains(value.kind)) throw new BadRequestException("Choose a public or confidential application.");
    value.origin = text(input, "origin", 2048);
    value.redirectUris = strings(input, "redirectUris", 1, 10);
    value.postLogoutRedirectUris = strings(input, "postLogoutRedirectUris", 0, 10);
    value.requiredPermissions = strings(input, "requiredPermissions", 1, 1000);
    value.enabled = (Boolean) input.get("enabled");
    value.version = update ? version(input) : null;
    for (String permission : value.requiredPermissions) {
      String namespace = permission.split(":", 2)[0].toLowerCase(Locale.ROOT);
      if (Set.of("identity", "admin-web", "account-web", "account", "realm-management", "broker", "admin-cli", "security-admin-console").contains(namespace)
          || namespace.startsWith("default-roles-"))
        throw new BadRequestException("Applications cannot request identity or native administrative permissions.");
    }
    var rule = toRule("score-app-validation", value);
    ClientAccessRules.validate(List.of(rule), registry.permissions.stream().map(permission -> permission.name)
        .collect(java.util.stream.Collectors.toSet()), registry.environment);
    value.redirectUris.forEach(url -> callback(url, value.origin, registry.environment));
    value.postLogoutRedirectUris.forEach(url -> callback(url, value.origin, registry.environment));
    return value;
  }

  private static Map<String, Object> configurationMap(Configuration value) {
    var result = new LinkedHashMap<String, Object>();
    result.put("name", value.name); result.put("kind", value.kind); result.put("origin", value.origin);
    result.put("redirectUris", value.redirectUris); result.put("postLogoutRedirectUris", value.postLogoutRedirectUris);
    result.put("requiredPermissions", value.requiredPermissions); result.put("enabled", value.enabled);
    result.put("version", value.version);
    return result;
  }

  @SuppressWarnings("unchecked")
  private static Configuration configuration(ClientModel client, AuthorizationResourceFactory.Registry registry) {
    if (!managed(client)) throw new NotFoundException("Managed application not found.");
    if (!"v1".equals(client.getAttribute(MANAGED)) || client.getClientId() == null
        || !client.getClientId().matches("score-app-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))
      throw conflict("The application ownership marker is invalid.");
    try {
      var body = JsonSerialization.readValue(client.getAttribute(CONFIG), Map.class);
      return validate((Map<String, Object>) body, registry, true);
    } catch (Exception error) {
      throw conflict("The managed application configuration is invalid.");
    }
  }

  private static ClientAccessRules.Rule toRule(String clientId, Configuration value) {
    var rule = new ClientAccessRules.Rule();
    rule.id = clientId; rule.clientId = clientId; rule.origin = value.origin;
    rule.requiredPermissions = new ArrayList<>(value.requiredPermissions);
    return rule;
  }

  private static List<ProtocolMapperModel> mappers(String clientId) {
    var result = new ArrayList<ProtocolMapperModel>();
    String[] names = {ClientAccessRules.OWNED_PREFIX + "authentication-policy", ClientAccessRules.OWNED_PREFIX + "realm-roles",
        ClientAccessRules.OWNED_PREFIX + "client-audience", "score-application-subject"};
    String[] providers = {"tentu-authentication-policy", "oidc-usermodel-realm-role-mapper", "oidc-audience-mapper", "oidc-sub-mapper"};
    var configs = List.of(Map.<String, String>of(), Map.of("access.token.claim", "true", "claim.name", "realm_access.roles",
        "jsonType.label", "String", "multivalued", "true"), Map.of("included.custom.audience", clientId,
        "access.token.claim", "true", "id.token.claim", "false"), Map.of("access.token.claim", "true", "introspection.token.claim", "true"));
    for (int index = 0; index < names.length; index++) {
      var mapper = new ProtocolMapperModel(); mapper.setName(names[index]); mapper.setProtocol(OIDC);
      mapper.setProtocolMapper(providers[index]); mapper.setConfig(new HashMap<>(configs.get(index))); result.add(mapper);
    }
    return result;
  }

  private static void actual(ClientModel client, Configuration value, RealmModel realm) {
    if (!Objects.equals(client.getName(), value.name) || !OIDC.equals(client.getProtocol())
        || client.isEnabled() != value.enabled || client.isPublicClient() != value.kind.equals("public")
        || !client.isStandardFlowEnabled() || client.isImplicitFlowEnabled() || client.isDirectAccessGrantsEnabled()
        || client.isServiceAccountsEnabled() || client.isFullScopeAllowed() || client.isBearerOnly() || client.isConsentRequired()
        || !"client-secret".equals(client.getClientAuthenticatorType())
        || !"S256".equals(client.getAttribute("pkce.code.challenge.method"))
        || !Objects.equals(client.getWebOrigins(), Set.of(value.origin))
        || !Objects.equals(client.getRedirectUris(), new HashSet<>(value.redirectUris))
        || !String.join("##", value.postLogoutRedirectUris).equals(client.getAttribute(LOGOUT)))
      throw conflict("Native client settings do not match the managed application configuration.");
    for (String permission : value.requiredPermissions) {
      var role = realm.getRole(permission);
      if (role == null || role.isClientRole() || role.isComposite()) throw conflict("An application permission is not an active atomic realm permission.");
    }
    var expectedPermissions = new HashSet<>(value.requiredPermissions);
    var scoped = client.getScopeMappingsStream().toList();
    if (scoped.size() != expectedPermissions.size() || scoped.stream().anyMatch(role -> role.isClientRole() || role.isComposite() || !expectedPermissions.contains(role.getName())))
      throw conflict("The native application token scope does not match its required permissions.");
    try {
      var owned = JsonSerialization.readValue(client.getAttribute(ClientTokenScopes.OWNED), String[].class);
      if (owned == null || owned.length != expectedPermissions.size() || !new HashSet<>(Arrays.asList(owned)).equals(expectedPermissions))
        throw new IllegalArgumentException();
    } catch (Exception error) { throw conflict("The application token scope ownership is invalid."); }
    if (!client.getClientScopes(false).isEmpty() || client.getClientScopes(true).values().stream().anyMatch(scope ->
        !Set.of("profile", "email").contains(scope.getName()) || !OIDC.equals(scope.getProtocol()) || scope.getScopeMappingsStream().findAny().isPresent()))
      throw conflict("The application has unexpected linked client scopes.");
    var installed = client.getProtocolMappersStream().toList();
    var expectedMappers = mappers(client.getClientId());
    if (installed.size() != expectedMappers.size() || expectedMappers.stream().anyMatch(expected -> installed.stream().filter(item ->
        expected.getName().equals(item.getName()) && expected.getProtocol().equals(item.getProtocol())
            && expected.getProtocolMapper().equals(item.getProtocolMapper()) && expected.getConfig().equals(item.getConfig())).count() != 1))
      throw conflict("The application has missing or unexpected token mappers.");
  }

  static ClientAccessRules.Rule rule(ClientModel client, AuthorizationResourceFactory.Registry registry) {
    if (!managed(client)) return null;
    try {
      var value = configuration(client, registry);
      actual(client, value, client.getRealm());
      return toRule(client.getClientId(), value);
    } catch (RuntimeException error) {
      throw new ForbiddenException("The managed application configuration could not be verified.");
    }
  }

  static Map<String, Object> view(ClientModel client, AuthorizationResourceFactory.Registry registry) {
    var value = configuration(client, registry);
    actual(client, value, client.getRealm());
    var result = configurationMap(value); result.put("clientId", client.getClientId());
    return result;
  }

  static List<Map<String, Object>> views(RealmModel realm, AuthorizationResourceFactory.Registry registry) {
    return realm.getClientsStream().filter(ApplicationsResourceFactory::managed).map(client -> view(client, registry))
        .sorted(Comparator.comparing(value -> (String) value.get("name"))).toList();
  }

  private static AuthorizationResourceFactory.Registry registry(RealmModel realm) {
    var registry = AuthorizationResourceFactory.read(realm);
    if (registry == null) throw new ServiceUnavailableException("The applied authorization catalogue is unavailable.");
    return registry;
  }

  private static void apply(RealmModel realm, ClientModel client, Configuration value) {
    client.setName(value.name); client.setProtocol(OIDC); client.setPublicClient(value.kind.equals("public"));
    client.setClientAuthenticatorType("client-secret"); client.setStandardFlowEnabled(true);
    client.setImplicitFlowEnabled(false); client.setDirectAccessGrantsEnabled(false); client.setServiceAccountsEnabled(false);
    client.setBearerOnly(false); client.setFullScopeAllowed(false); client.setConsentRequired(false);
    client.setRedirectUris(new HashSet<>(value.redirectUris)); client.setWebOrigins(Set.of(value.origin));
    client.setAttribute(LOGOUT, String.join("##", value.postLogoutRedirectUris));
    client.setAttribute("pkce.code.challenge.method", "S256");
    for (boolean defaults : List.of(true, false))
      for (var scope : client.getClientScopes(defaults).values().stream().toList()) client.removeClientScope(scope);
    for (var scope : realm.getClientScopesStream().filter(scope -> OIDC.equals(scope.getProtocol()) && Set.of("profile", "email").contains(scope.getName())).toList())
      client.addClientScope(scope, true);
    // The transaction stays private until completion; helper preflight requires an enabled client.
    client.setEnabled(true);
    var scope = new ClientTokenScopes.Scope(); scope.clientId = client.getClientId(); scope.permissions = new ArrayList<>(value.requiredPermissions);
    ClientTokenScopes.reconcile(realm, List.of(scope), null);
    ClientAccessRules.reconcile(realm, List.of(toRule(client.getClientId(), value)));
    var subject = mappers(client.getClientId()).getLast();
    if (client.getProtocolMappersStream().noneMatch(mapper -> subject.getName().equals(mapper.getName()))) client.addProtocolMapper(subject);
    client.setEnabled(value.enabled);
    client.setAttribute(MANAGED, "v1");
    client.setAttribute(CONFIG, AuthorizationResourceFactory.serialize(configurationMap(value)));
  }

  static void clearSecret(ClientModel client) {
    client.setSecret(null);
    // Keycloak can otherwise accept a previous secret through its rotation grace attributes.
    for (String attribute : List.of("client.secret.creation.time", "client.secret.rotated", "client.secret.rotated.creation.time", "client.secret.rotated.expiration.time",
        "client.secret.expiration.time", "client.secret.remaining.expiration.time")) client.removeAttribute(attribute);
  }

  static String rotateSecret(ClientModel client) {
    clearSecret(client);
    return KeycloakModelUtils.generateSecret(client);
  }

  static void invalidateSessions(KeycloakSession session, RealmModel realm, ClientModel client) {
    var provider = session.sessions();
    // Authorization codes bind the parent user-session ID, not the client-session ID.
    // Detaching only the client can let an unspent code revive after SSO reattachment.
    // Other clients sharing these particular SSO sessions are signed out as well.
    try (var online = provider.getUserSessionsStream(realm, client);
         var offline = provider.getOfflineUserSessionsStream(realm, client, null, null)) {
      var onlineSessions = online.toList();
      var offlineSessions = offline.toList();
      onlineSessions.forEach(value -> provider.removeUserSession(realm, value));
      offlineSessions.forEach(value -> provider.removeOfflineUserSession(realm, value));
    }
  }

  public static class Resource {
    final KeycloakSession session;
    final RealmModel realm;
    Resource(KeycloakSession session) { this.session = session; this.realm = session.getContext().getRealm(); }
    AuthResult authenticate() { return new AppAuthManager.BearerTokenAuthenticator(session).setAudience("identity-admin-api").authenticate(); }
    void authorize() { ApplicationsResourceFactory.authorize(realm, authenticate()); }
    private Response change(Supplier<Response> action) {
      AuthorizationResourceFactory.acquire(session, realm);
      authorize();
      try { return action.get(); }
      catch (RuntimeException error) { session.getTransactionManager().setRollbackOnly(); throw error; }
    }
    private ClientModel target(String clientId) {
      var client = realm.getClientByClientId(clientId);
      if (!managed(client)) throw new NotFoundException("Managed application not found.");
      return client;
    }
    private Response response(Object entity, int status) {
      return Response.status(status).entity(entity).header("Cache-Control", "no-store").header("Pragma", "no-cache").build();
    }
    @GET @Produces("application/json")
    public Response list() { authorize(); return response(Map.of("applications", views(realm, registry(realm))), 200); }
    @POST @Consumes("application/json") @Produces("application/json")
    public Response create(Map<String, Object> input) {
      return change(() -> {
        var registry = registry(realm); var value = validate(input, registry, false);
        value.version = UUID.randomUUID().toString();
        var client = realm.addClient(PREFIX + UUID.randomUUID());
        apply(realm, client, value);
        var entity = new LinkedHashMap<String, Object>(); entity.put("application", view(client, registry));
        if (value.kind.equals("confidential")) entity.put("clientSecret", rotateSecret(client));
        else client.setSecret(null);
        return response(entity, 201);
      });
    }
    @PUT @Path("{clientId}") @Consumes("application/json") @Produces("application/json")
    public Response update(@PathParam("clientId") String clientId, Map<String, Object> input) {
      return change(() -> {
        var registry = registry(realm); var client = target(clientId); var previous = configuration(client, registry);
        actual(client, previous, realm);
        var value = validate(input, registry, true);
        if (!previous.version.equals(value.version)) throw conflict("The application changed. Reload it before saving.");
        boolean transition = !previous.kind.equals(value.kind);
        if (transition) invalidateSessions(session, realm, client);
        value.version = UUID.randomUUID().toString(); apply(realm, client, value);
        var entity = new LinkedHashMap<String, Object>();
        if (transition) {
          if (value.kind.equals("confidential")) entity.put("clientSecret", rotateSecret(client));
          else clearSecret(client);
        }
        entity.put("application", view(client, registry));
        return response(entity, 200);
      });
    }
    @POST @Path("{clientId}/secret") @Consumes("application/json") @Produces("application/json")
    public Response rotate(@PathParam("clientId") String clientId, Map<String, Object> input) {
      return change(() -> {
        if (input == null || !input.keySet().equals(Set.of("version"))) throw new BadRequestException("Provide the current application version.");
        var registry = registry(realm); var client = target(clientId); var value = configuration(client, registry);
        actual(client, value, realm);
        if (!value.version.equals(version(input))) throw conflict("The application changed. Reload it before rotating its secret.");
        if (!value.kind.equals("confidential")) throw conflict("Public applications do not have client secrets.");
        String secret = rotateSecret(client); value.version = UUID.randomUUID().toString();
        client.setAttribute(CONFIG, AuthorizationResourceFactory.serialize(configurationMap(value)));
        return response(Map.of("clientId", clientId, "clientSecret", secret, "application", view(client, registry)), 200);
      });
    }
    @POST @Path("{clientId}/secret/reveal") @Consumes("application/json") @Produces("application/json")
    public Response reveal(@PathParam("clientId") String clientId, Map<String, Object> input) {
      return change(() -> {
        if (input == null || !input.keySet().equals(Set.of("version"))) throw new BadRequestException("Provide the current application version.");
        var registry = registry(realm); var client = target(clientId); var value = configuration(client, registry);
        actual(client, value, realm);
        if (!value.version.equals(version(input))) throw conflict("The application changed. Reload it before revealing its secret.");
        if (!value.kind.equals("confidential")) throw conflict("Public applications do not have client secrets.");
        String secret = client.getSecret();
        if (secret == null || secret.isBlank()) throw conflict("The confidential application does not have a current client secret.");
        return response(Map.of("clientId", clientId, "clientSecret", secret, "version", value.version), 200);
      });
    }
    @DELETE @Path("{clientId}") @Consumes("application/json") @Produces("application/json")
    public Response delete(@PathParam("clientId") String clientId, Map<String, Object> input) {
      return change(() -> {
        if (input == null || !input.keySet().equals(Set.of("version"))) throw new BadRequestException("Provide the current application version.");
        String expected = version(input);
        var registry = registry(realm); var client = target(clientId); var value = configuration(client, registry);
        actual(client, value, realm);
        if (!value.version.equals(expected)) throw conflict("The application changed. Reload it before deleting it.");
        // The canonical manager cleans up client connections without ending parent SSO sessions.
        // Reject unexpected service-account ownership rather than letting it remove a user.
        if (session.users().getServiceAccount(client) != null) throw conflict("The managed application has an unexpected service account.");
        if (!new ClientManager(new RealmManager(session)).removeClient(realm, client))
          throw conflict("The application could not be deleted. Reload it before trying again.");
        return response(Map.of("clientId", clientId, "deleted", true), 200);
      });
    }
  }
}
