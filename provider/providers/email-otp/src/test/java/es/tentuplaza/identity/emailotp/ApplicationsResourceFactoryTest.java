package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import jakarta.ws.rs.*;
import jakarta.ws.rs.core.Response;
import java.util.*;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.keycloak.models.*;
import org.keycloak.events.EventBuilder;
import org.keycloak.protocol.oidc.utils.OAuth2Code;
import org.keycloak.protocol.oidc.utils.OAuth2CodeParser;
import org.keycloak.representations.AccessToken;
import org.keycloak.services.managers.AuthenticationManager.AuthResult;

class ApplicationsResourceFactoryTest {
  static final String ATOM = "analytics:admin";
  static final String OTHER = "analytics:view";
  static final String ORIGIN = "https://analytics.score.us.es";

  static Map<String, Object> input(String kind) {
    var value = new HashMap<String, Object>();
    value.put("name", "Analytics application"); value.put("kind", kind); value.put("origin", ORIGIN);
    value.put("redirectUris", List.of(ORIGIN + "/callback", ORIGIN + "/verification"));
    value.put("postLogoutRedirectUris", List.of(ORIGIN + "/signed-out"));
    value.put("requiredPermissions", List.of(ATOM)); value.put("enabled", true);
    return value;
  }

  final class NativeClient {
    final Map<String, Object> values = new HashMap<>();
    final Map<String, String> attributes = new HashMap<>();
    final List<ProtocolMapperModel> mappers = new ArrayList<>();
    final Set<RoleModel> scoped = new LinkedHashSet<>();
    final Map<String, ClientScopeModel> defaults = new HashMap<>(), optional = new HashMap<>();
    final ClientModel client;
    NativeClient(String id, RealmModel realm) {
      values.put("ClientId", id);
      values.put("Id", UUID.randomUUID().toString());
      client = mock(ClientModel.class, invocation -> {
        String method = invocation.getMethod().getName(); Object[] args = invocation.getArguments();
        return switch (method) {
          case "getRealm" -> realm;
          case "getAttribute" -> attributes.get((String) args[0]);
          case "setAttribute" -> { attributes.put((String) args[0], (String) args[1]); yield null; }
          case "removeAttribute" -> { attributes.remove((String) args[0]); yield null; }
          case "getProtocolMappersStream" -> mappers.stream();
          case "addProtocolMapper" -> { mappers.add((ProtocolMapperModel) args[0]); yield args[0]; }
          case "getScopeMappingsStream" -> scoped.stream();
          case "addScopeMapping" -> { scoped.add((RoleModel) args[0]); yield null; }
          case "deleteScopeMapping" -> { scoped.remove(args[0]); yield null; }
          case "getClientScopes" -> (Boolean) args[0] ? defaults : optional;
          case "addClientScope" -> { var scope = (ClientScopeModel) args[0]; ((Boolean) args[1] ? defaults : optional).put(scope.getId(), scope); yield null; }
          case "removeClientScope" -> { var scope = (ClientScopeModel) args[0]; defaults.remove(scope.getId()); optional.remove(scope.getId()); yield null; }
          default -> {
            if (method.startsWith("set") && args.length == 1) { values.put(method.substring(3), args[0]); yield null; }
            if (method.startsWith("get") && args.length == 0 && values.containsKey(method.substring(3))) yield values.get(method.substring(3));
            if (method.startsWith("is") && args.length == 0 && values.containsKey(method.substring(2))) yield values.get(method.substring(2));
            yield org.mockito.Answers.RETURNS_DEFAULTS.answer(invocation);
          }
        };
      });
    }
  }

  final class Fixture {
    final KeycloakSession session = mock(KeycloakSession.class, RETURNS_DEEP_STUBS);
    final RealmModel realm = mock(RealmModel.class);
    final UserModel actor = mock(UserModel.class, RETURNS_DEEP_STUBS);
    final UserSessionModel userSession = mock(UserSessionModel.class);
    final ClientModel adminClient = mock(ClientModel.class);
    final Map<String, RoleModel> roles = new HashMap<>();
    final Set<RoleModel> grants = new HashSet<>();
    final Map<String, NativeClient> clients = new LinkedHashMap<>();
    final List<ClientScopeModel> scopes = new ArrayList<>();
    final Map<String, String> notes = new HashMap<>();
    final AuthorizationResourceFactory.Registry registry = new AuthorizationResourceFactory.Registry();
    final AccessToken token = new AccessToken();
    final AuthResult auth;
    final ApplicationsResourceFactory.Resource resource;
    int authentications;
    Fixture() {
      registry.environment = "local";
      for (String name : List.of(ATOM, OTHER, "identity:roles:manage", "admin-web:local:access", "administrador")) {
        var role = mock(RoleModel.class); when(role.getName()).thenReturn(name); roles.put(name, role); grants.add(role);
        if (!name.equals("administrador")) {
          var permission = new AuthorizationResourceFactory.Permission(); permission.name = name; permission.owner = "test-service"; registry.permissions.add(permission);
        }
      }
      when(realm.getRole(anyString())).thenAnswer(call -> roles.get(call.getArgument(0)));
      when(realm.getName()).thenReturn("score");
      when(realm.getAttribute(AuthorizationResourceFactory.ACTIVE)).thenAnswer(call -> AuthorizationResourceFactory.serialize(registry));
      when(realm.getClientByClientId(anyString())).thenAnswer(call -> { var client = clients.get(call.getArgument(0)); return client == null ? null : client.client; });
      when(realm.addClient(anyString())).thenAnswer(call -> { String id = call.getArgument(0); var client = new NativeClient(id, realm); clients.put(id, client); return client.client; });
      when(realm.getClientsStream()).thenAnswer(call -> clients.values().stream().map(client -> client.client));
      when(realm.removeClient(anyString())).thenAnswer(call -> {
        String id = call.getArgument(0);
        var owned = clients.entrySet().stream().filter(entry -> id.equals(entry.getValue().client.getId())).findFirst();
        if (owned.isEmpty()) return false;
        clients.remove(owned.get().getKey()); return true;
      });
      when(realm.getClientScopesStream()).thenAnswer(call -> scopes.stream());
      when(session.getContext().getRealm()).thenReturn(realm);
      when(session.singleUseObjects().putIfAbsent(anyString(), anyLong())).thenReturn(true);
      when(session.users().getServiceAccount(any(ClientModel.class))).thenReturn(null);
      when(session.sessions().getUserSessionsStream(eq(realm), any(ClientModel.class))).thenAnswer(call -> Stream.empty());
      when(session.sessions().getOfflineUserSessionsStream(eq(realm), any(ClientModel.class), isNull(), isNull())).thenAnswer(call -> Stream.empty());
      when(actor.getId()).thenReturn("operator"); when(actor.isEnabled()).thenReturn(true);
      when(actor.hasRole(any())).thenAnswer(call -> grants.contains(call.getArgument(0)));
      when(actor.credentialManager().isConfiguredFor(AuthenticationPolicy.PASSKEY)).thenReturn(true);
      when(adminClient.getClientId()).thenReturn("identity-admin-web"); when(adminClient.isEnabled()).thenReturn(true);
      when(userSession.getUser()).thenReturn(actor); when(userSession.getState()).thenReturn(UserSessionModel.State.LOGGED_IN);
      notes.put(AuthenticationPolicy.METHOD, AuthenticationPolicy.PASSKEY); notes.put(AuthenticationPolicy.ADMIN, "true");
      when(userSession.getNote(anyString())).thenAnswer(call -> notes.get(call.getArgument(0)));
      token.issuedFor("identity-admin-web"); token.audience("identity-admin-api"); token.subject("operator");
      token.setRealmAccess(new AccessToken.Access().addRole("identity:roles:manage").addRole("admin-web:local:access"));
      token.getOtherClaims().put("tentu_auth_method", AuthenticationPolicy.PASSKEY);
      token.getOtherClaims().put("tentu_admin_verified", true);
      auth = new AuthResult(actor, userSession, token, adminClient);
      resource = new ApplicationsResourceFactory.Resource(session) {
        @Override AuthResult authenticate() { authentications++; return auth; }
      };
    }
    @SuppressWarnings("unchecked") Map<String, Object> application(Response response) { return (Map<String, Object>) ((Map<?, ?>) response.getEntity()).get("application"); }
    Map<String, Object> update(Map<String, Object> view) { var body = new HashMap<>(view); body.remove("clientId"); return body; }
    NativeClient nativeClient(Map<String, Object> view) { return clients.get(view.get("clientId")); }
    Map<String, Object> create(String kind) { return application(resource.create(input(kind))); }
  }

  @Test void catalogueCannotDeleteAnApplicationRequirementBeforeAnyNativeMutation() {
    var f = new Fixture(); f.create("public");
    var next = new AuthorizationResourceFactory.Registry(); next.environment = "local";
    next.permissions = f.registry.permissions.stream().filter(permission -> !ATOM.equals(permission.name)).toList();
    clearInvocations(f.realm);
    assertThrows(ClientErrorException.class, () -> AuthorizationResourceFactory.reconcile(f.realm, next, f.registry));
    verify(f.realm, never()).removeRole(any()); verify(f.realm, never()).addRole(anyString());
    for (var role : f.roles.values()) verify(role, never()).removeCompositeRole(any());
    assertEquals(1, f.clients.size());
  }

  @Test void validatesExactOriginsCallbacksBoundsAndReservedPermissions() {
    var f = new Fixture(); assertDoesNotThrow(() -> ApplicationsResourceFactory.validate(input("public"), f.registry, false));
    for (var patch : List.<Map<String, Object>>of(Map.of("origin", "https://analytics.score.us.es/"),
        Map.of("redirectUris", List.of("https://analytics.score.us.es.evil/callback")), Map.of("redirectUris", List.of(ORIGIN + "/*")),
        Map.of("redirectUris", List.of(ORIGIN + "/callback#fragment")), Map.of("redirectUris", List.of("https://user@analytics.score.us.es/callback")),
        Map.of("postLogoutRedirectUris", List.of("https://other.score.us.es/out")), Map.of("redirectUris", List.of()),
        Map.of("redirectUris", Collections.nCopies(11, ORIGIN + "/callback")), Map.of("kind", "machine"),
        Map.of("requiredPermissions", List.of()), Map.of("requiredPermissions", List.of("identity:roles:manage")),
        Map.of("requiredPermissions", List.of("admin-web:local:access")), Map.of("requiredPermissions", List.of(ATOM, ATOM)),
        Map.of("requiredPermissions", List.of("unknown:admin")), Map.of("clientSecret", "injected"), Map.of("version", UUID.randomUUID().toString()))) {
      var body = input("public"); body.putAll(patch);
      assertThrows(BadRequestException.class, () -> ApplicationsResourceFactory.validate(body, f.registry, false));
    }
    var local = input("public"); local.put("origin", "http://localhost:18000"); local.put("redirectUris", List.of("http://localhost:18000/callback")); local.put("postLogoutRedirectUris", List.of());
    assertDoesNotThrow(() -> ApplicationsResourceFactory.validate(local, f.registry, false));
    f.registry.environment = "production";
    assertThrows(BadRequestException.class, () -> ApplicationsResourceFactory.validate(local, f.registry, false));
  }

  @Test void requiresLiveAdministratorSignedAtomicAuthorityAndPasskeyWithoutNewFiveMinuteChallenge() {
    var f = new Fixture(); f.token.setAuth_time(1L);
    assertFalse(f.token.getRealmAccess().isUserInRole("administrador"));
    assertDoesNotThrow(() -> ApplicationsResourceFactory.authorize(f.realm, f.auth));
    f.grants.remove(f.roles.get("administrador"));
    assertThrows(ForbiddenException.class, () -> ApplicationsResourceFactory.authorize(f.realm, f.auth));
    f.grants.add(f.roles.get("administrador")); f.token.getRealmAccess().getRoles().remove("identity:roles:manage");
    assertThrows(ForbiddenException.class, () -> ApplicationsResourceFactory.authorize(f.realm, f.auth));
    f.token.getRealmAccess().addRole("identity:roles:manage"); f.notes.put(AuthenticationPolicy.ADMIN, "false");
    assertThrows(ForbiddenException.class, () -> ApplicationsResourceFactory.authorize(f.realm, f.auth));
    f.notes.put(AuthenticationPolicy.ADMIN, "true"); f.token.getOtherClaims().put("tentu_admin_verified", "true");
    assertThrows(ForbiddenException.class, () -> ApplicationsResourceFactory.authorize(f.realm, f.auth));
    f.token.getOtherClaims().put("tentu_admin_verified", true); when(f.actor.getServiceAccountClientLink()).thenReturn("machine");
    assertThrows(ForbiddenException.class, () -> ApplicationsResourceFactory.authorize(f.realm, f.auth));
    assertThrows(NotAuthorizedException.class, () -> ApplicationsResourceFactory.authorize(f.realm, null));
  }

  @Test void mutationLocksBeforeFreshAuthorizationAndRejectsConcurrentEntry() {
    var f = new Fixture();
    when(f.session.singleUseObjects().putIfAbsent(anyString(), anyLong())).thenReturn(false);
    assertThrows(ClientErrorException.class, () -> f.resource.create(input("public")));
    assertEquals(0, f.authentications); verify(f.realm, never()).addClient(anyString());
  }

  @Test void createsConfidentialClientWithNativeSecretAndIsolatedMappersAndScopes() {
    var f = new Fixture(); var response = f.resource.create(input("confidential")); var view = f.application(response);
    assertEquals(201, response.getStatus()); assertEquals("no-store", response.getHeaderString("Cache-Control"));
    assertTrue(((Map<?, ?>) response.getEntity()).get("clientSecret") instanceof String secret && secret.length() >= 32);
    assertTrue(((String) view.get("clientId")).startsWith("score-app-"));
    var client = f.nativeClient(view);
    assertEquals(false, client.values.get("PublicClient")); assertEquals(false, client.values.get("ServiceAccountsEnabled"));
    assertEquals(false, client.values.get("DirectAccessGrantsEnabled")); assertEquals(false, client.values.get("ImplicitFlowEnabled"));
    assertEquals(false, client.values.get("FullScopeAllowed")); assertEquals("S256", client.attributes.get("pkce.code.challenge.method"));
    assertEquals(Set.of(f.roles.get(ATOM)), client.scoped); assertEquals(4, client.mappers.size());
    assertEquals(List.of(ATOM), ApplicationsResourceFactory.rule(client.client, f.registry).requiredPermissions);
    assertFalse(client.attributes.get(ApplicationsResourceFactory.CONFIG).contains("clientSecret"));
    verify(client.client, never()).getSecret();
  }

  @Test void publicClientsAndListNeverExposeOrReadASecret() {
    var f = new Fixture(); var response = f.resource.create(input("public")); var view = f.application(response); var client = f.nativeClient(view);
    assertFalse(((Map<?, ?>) response.getEntity()).containsKey("clientSecret"));
    assertNull(client.values.get("Secret"));
    var listed = f.resource.list();
    assertFalse(AuthorizationResourceFactory.serialize(listed.getEntity()).contains("clientSecret"));
    assertEquals(1, ((List<?>) ((Map<?, ?>) listed.getEntity()).get("applications")).size());
    verify(client.client, never()).getSecret();
    assertThrows(ClientErrorException.class, () -> f.resource.rotate((String) view.get("clientId"), Map.of("version", view.get("version"))));
  }

  @Test void updateRequiresCurrentVersionAndChangesOnlyOwnedClient() {
    var f = new Fixture(); var view = f.create("public"); var client = f.nativeClient(view); var body = f.update(view);
    body.put("name", "Updated analytics"); body.put("requiredPermissions", List.of(OTHER));
    var updated = f.application(f.resource.update((String) view.get("clientId"), body));
    assertNotEquals(view.get("version"), updated.get("version")); assertEquals(Set.of(f.roles.get(OTHER)), client.scoped);
    assertThrows(ClientErrorException.class, () -> f.resource.update((String) view.get("clientId"), body));
    var missingVersion = f.update(updated); missingVersion.remove("version");
    assertThrows(BadRequestException.class, () -> f.resource.update((String) view.get("clientId"), missingVersion));
    assertThrows(NotFoundException.class, () -> f.resource.update("identity-admin-web", f.update(updated)));
    verify(f.session.getTransactionManager(), atLeastOnce()).setRollbackOnly();
  }

  @Test void kindTransitionsKeepClientIdAndReplaceCredentialsOnlyWhenNeeded() {
    var f = new Fixture(); var confidential = f.create("confidential"); var client = f.nativeClient(confidential);
    Object originalSecret = client.values.get("Secret");
    for (String attribute : List.of("client.secret.rotated", "client.secret.rotated.creation.time", "client.secret.rotated.expiration.time",
        "client.secret.expiration.time", "client.secret.remaining.expiration.time")) client.attributes.put(attribute, "old-grace");
    var downgrade = f.update(confidential); downgrade.put("kind", "public");
    var publicResponse = f.resource.update((String) confidential.get("clientId"), downgrade);
    var publicView = f.application(publicResponse);
    assertEquals(confidential.get("clientId"), publicView.get("clientId"));
    assertEquals(confidential.get("requiredPermissions"), publicView.get("requiredPermissions"));
    assertEquals("public", publicView.get("kind")); assertEquals(true, client.values.get("PublicClient"));
    assertNull(client.values.get("Secret"));
    assertFalse(((Map<?, ?>) publicResponse.getEntity()).containsKey("clientSecret"));
    assertFalse(client.attributes.keySet().stream().anyMatch(name -> name.startsWith("client.secret.")));
    var upgrade = f.update(publicView); upgrade.put("kind", "confidential");
    var upgradedResponse = f.resource.update((String) publicView.get("clientId"), upgrade);
    var upgradedView = f.application(upgradedResponse);
    assertEquals(publicView.get("clientId"), upgradedView.get("clientId"));
    assertNotEquals(publicView.get("version"), upgradedView.get("version"));
    assertEquals(false, client.values.get("PublicClient"));
    assertTrue(((Map<?, ?>) upgradedResponse.getEntity()).get("clientSecret") instanceof String secret && secret.length() >= 32);
    assertFalse(Objects.equals(originalSecret, client.values.get("Secret")));
    assertFalse(AuthorizationResourceFactory.serialize(f.resource.list().getEntity()).contains((String) client.values.get("Secret")));
    verify(client.client, never()).setNotBefore(anyInt());
  }

  @Test void ordinaryEditsAndRotationDoNotInvalidateSessionsAndEditsDoNotRotateSecrets() {
    var f = new Fixture(); var initial = f.create("confidential"); var client = f.nativeClient(initial);
    Object secret = client.values.get("Secret"); clearInvocations(client.client);
    var body = f.update(initial); body.put("name", "Renamed application");
    var response = f.resource.update((String) initial.get("clientId"), body);
    assertFalse(((Map<?, ?>) response.getEntity()).containsKey("clientSecret"));
    assertTrue(Objects.equals(secret, client.values.get("Secret")));
    verify(client.client, never()).setSecret(any());
    f.resource.rotate((String) initial.get("clientId"), Map.of("version", f.application(response).get("version")));
    verify(f.session.sessions(), never()).getUserSessionsStream(eq(f.realm), any(ClientModel.class));
    verify(f.session.sessions(), never()).removeUserSession(any(), any());
    verify(f.session.sessions(), never()).removeOfflineUserSession(any(), any());
  }

  @Test void staleTransitionCannotChangeCredentialsKindOrSessions() {
    var f = new Fixture(); var initial = f.create("confidential"); var client = f.nativeClient(initial);
    Object secret = client.values.get("Secret"); var body = f.update(initial);
    body.put("kind", "public"); body.put("version", UUID.randomUUID().toString()); clearInvocations(client.client);
    assertThrows(ClientErrorException.class, () -> f.resource.update((String) initial.get("clientId"), body));
    assertEquals(false, client.values.get("PublicClient")); assertTrue(Objects.equals(secret, client.values.get("Secret")));
    verify(client.client, never()).setSecret(any()); verify(client.client, never()).setPublicClient(anyBoolean());
    verify(f.session.sessions(), never()).removeUserSession(any(), any());
    verify(f.session.sessions(), never()).removeOfflineUserSession(any(), any());
  }

  @Test void transitionRemovesOnlySessionsUsingClientAndInvalidatesNativeAuthorizationCodes() {
    var f = new Fixture(); var initial = f.create("confidential"); var client = f.nativeClient(initial);
    var online = mock(UserSessionModel.class); var offline = mock(UserSessionModel.class); var unrelated = mock(UserSessionModel.class);
    when(online.getId()).thenReturn("previous-sso"); when(online.getRealm()).thenReturn(f.realm);
    var attached = mock(AuthenticatedClientSessionModel.class); when(attached.getUserSession()).thenReturn(online); when(attached.getClient()).thenReturn(client.client);
    when(online.getAuthenticatedClientSessionByClient(client.client.getId())).thenReturn(attached);
    var onlineSessions = new ArrayList<>(List.of(online)); var offlineSessions = new ArrayList<>(List.of(offline));
    var provider = f.session.sessions(); var singleUse = f.session.singleUseObjects();
    when(f.session.sessions().getUserSessionsStream(f.realm, client.client)).thenAnswer(call -> onlineSessions.stream());
    when(f.session.sessions().getOfflineUserSessionsStream(f.realm, client.client, null, null)).thenAnswer(call -> offlineSessions.stream());
    when(f.session.sessions().getUserSessionIfClientExists(f.realm, "previous-sso", false, client.client.getId()))
        .thenAnswer(call -> onlineSessions.isEmpty() ? null : online);
    when(f.session.sessions().getUserSession(f.realm, "previous-sso")).thenAnswer(call -> onlineSessions.isEmpty() ? null : online);
    doAnswer(call -> { onlineSessions.remove(call.getArgument(1)); return null; }).when(provider).removeUserSession(eq(f.realm), any());
    doAnswer(call -> { offlineSessions.remove(call.getArgument(1)); return null; }).when(provider).removeOfflineUserSession(eq(f.realm), any());
    var codes = new HashMap<String, Map<String, String>>();
    doAnswer(call -> { codes.put(call.getArgument(0), call.getArgument(2)); return null; }).when(singleUse).put(anyString(), anyLong(), anyMap());
    when(f.session.singleUseObjects().remove(anyString())).thenAnswer(call -> codes.remove(call.getArgument(0)));
    var event = mock(EventBuilder.class, RETURNS_SELF);
    int expires = (int) java.time.Instant.now().plusSeconds(60).getEpochSecond();
    String baseline = OAuth2CodeParser.persistCode(f.session, attached, new OAuth2Code(UUID.randomUUID().toString(), expires, "nonce", "openid", "previous-sso"));
    assertFalse(OAuth2CodeParser.parseCode(f.session, baseline, f.realm, event).isIllegalCode());
    String unspent = OAuth2CodeParser.persistCode(f.session, attached, new OAuth2Code(UUID.randomUUID().toString(), expires, "nonce", "openid", "previous-sso"));
    var body = f.update(initial); body.put("kind", "public"); f.resource.update((String) initial.get("clientId"), body);
    assertTrue(onlineSessions.isEmpty()); assertTrue(offlineSessions.isEmpty());
    verify(f.session.sessions()).removeUserSession(f.realm, online); verify(f.session.sessions()).removeOfflineUserSession(f.realm, offline);
    verify(f.session.sessions(), never()).removeUserSession(f.realm, unrelated);
    verify(f.session.sessions(), never()).removeUserSessions(any(RealmModel.class));
    assertTrue(OAuth2CodeParser.parseCode(f.session, unspent, f.realm, event).isIllegalCode());
  }

  @Test void disabledApplicationKeepsItsRuleAndCanBeReenabledSafely() {
    var f = new Fixture(); var view = f.create("public"); var client = f.nativeClient(view); var body = f.update(view); body.put("enabled", false);
    var disabled = f.application(f.resource.update((String) view.get("clientId"), body));
    assertFalse(client.client.isEnabled()); assertNotNull(ApplicationsResourceFactory.rule(client.client, f.registry));
    body = f.update(disabled); body.put("enabled", true);
    assertEquals(true, f.application(f.resource.update((String) view.get("clientId"), body)).get("enabled"));
  }

  @Test void rotationRequiresVersionInvalidatesGraceAndNeverReturnsSecretFromLaterGet() {
    var f = new Fixture(); var view = f.create("confidential"); var client = f.nativeClient(view); Object previousSecret = client.values.get("Secret");
    for (String attribute : List.of("client.secret.rotated", "client.secret.rotated.creation.time", "client.secret.rotated.expiration.time", "client.secret.expiration.time", "client.secret.remaining.expiration.time")) client.attributes.put(attribute, "stale");
    var rotated = f.resource.rotate((String) view.get("clientId"), Map.of("version", view.get("version")));
    assertTrue(((Map<?, ?>) rotated.getEntity()).get("clientSecret") instanceof String);
    assertFalse(Objects.equals(previousSecret, client.values.get("Secret")));
    assertFalse(client.attributes.keySet().stream().anyMatch(name -> name.startsWith("client.secret.rotated") || name.equals("client.secret.expiration.time") || name.equals("client.secret.remaining.expiration.time")));
    assertNotEquals(view.get("version"), f.application(rotated).get("version"));
    assertThrows(ClientErrorException.class, () -> f.resource.rotate((String) view.get("clientId"), Map.of("version", view.get("version"))));
    assertThrows(BadRequestException.class, () -> f.resource.rotate((String) view.get("clientId"), Map.of()));
    assertFalse(AuthorizationResourceFactory.serialize(f.resource.list().getEntity()).contains((String) client.values.get("Secret")));
    verify(client.client, never()).getSecret();
  }

  @Test void revealReturnsSameCurrentSecretWithoutChangingVersionCredentialsOrSessions() {
    var f = new Fixture(); var view = f.create("confidential"); var client = f.nativeClient(view);
    Object secret = client.values.get("Secret"); var attributes = new HashMap<>(client.attributes);
    clearInvocations(client.client);
    for (int attempt = 0; attempt < 2; attempt++) {
      var response = f.resource.reveal((String) view.get("clientId"), Map.of("version", view.get("version")));
      var value = (Map<?, ?>) response.getEntity();
      assertEquals(200, response.getStatus()); assertEquals("no-store", response.getHeaderString("Cache-Control"));
      assertEquals("no-cache", response.getHeaderString("Pragma"));
      assertEquals(view.get("clientId"), value.get("clientId")); assertEquals(view.get("version"), value.get("version"));
      assertTrue(Objects.equals(secret, value.get("clientSecret")));
      assertEquals(Set.of("clientId", "clientSecret", "version"), value.keySet());
    }
    assertTrue(Objects.equals(secret, client.values.get("Secret"))); assertEquals(attributes, client.attributes);
    verify(client.client, times(2)).getSecret(); verify(client.client, never()).setSecret(any());
    verify(client.client, never()).setAttribute(anyString(), any()); verify(client.client, never()).removeAttribute(anyString());
    verify(f.session.sessions(), never()).removeUserSession(any(), any());
    verify(f.session.sessions(), never()).removeOfflineUserSession(any(), any());
    clearInvocations(client.client);
    f.resource.list(); ApplicationsResourceFactory.view(client.client, f.registry);
    verify(client.client, never()).getSecret();
  }

  @Test void revealRejectsStalePublicMissingSecretAndUnownedClients() {
    var f = new Fixture(); var view = f.create("confidential"); var client = f.nativeClient(view);
    assertThrows(ClientErrorException.class, () -> f.resource.reveal((String) view.get("clientId"), Map.of("version", UUID.randomUUID().toString())));
    assertThrows(BadRequestException.class, () -> f.resource.reveal((String) view.get("clientId"), Map.of()));
    verify(client.client, never()).getSecret();
    var publicView = f.create("public"); var publicClient = f.nativeClient(publicView);
    assertThrows(ClientErrorException.class, () -> f.resource.reveal((String) publicView.get("clientId"), Map.of("version", publicView.get("version"))));
    verify(publicClient.client, never()).getSecret();
    client.values.remove("Secret");
    assertThrows(ClientErrorException.class, () -> f.resource.reveal((String) view.get("clientId"), Map.of("version", view.get("version"))));
    client.attributes.remove(ApplicationsResourceFactory.MANAGED); clearInvocations(client.client);
    assertThrows(NotFoundException.class, () -> f.resource.reveal((String) view.get("clientId"), Map.of("version", view.get("version"))));
    verify(client.client, never()).getSecret();
  }

  @Test void revealRechecksAdministratorAndNativeConfigurationBeforeReadingSecret() {
    var f = new Fixture(); var view = f.create("confidential"); var client = f.nativeClient(view);
    clearInvocations(client.client);
    f.grants.remove(f.roles.get("administrador"));
    assertThrows(ForbiddenException.class, () -> f.resource.reveal((String) view.get("clientId"), Map.of("version", view.get("version"))));
    f.grants.add(f.roles.get("administrador")); client.attributes.put("pkce.code.challenge.method", "plain");
    assertThrows(ClientErrorException.class, () -> f.resource.reveal((String) view.get("clientId"), Map.of("version", view.get("version"))));
    verify(client.client, never()).getSecret(); verify(client.client, never()).setSecret(any());
  }

  @Test void deleteRemovesOnlyOwnedClientThroughCanonicalCleanupAndPreservesOtherSsoConnections() {
    var f = new Fixture(); var view = f.create("confidential"); var client = f.nativeClient(view);
    var otherView = f.create("public"); var other = f.nativeClient(otherView);
    var parent = mock(UserSessionModel.class); var offlineParent = mock(UserSessionModel.class);
    var attached = mock(AuthenticatedClientSessionModel.class); var unrelated = mock(AuthenticatedClientSessionModel.class);
    var online = new HashMap<>(Map.of(client.client.getId(), attached, other.client.getId(), unrelated));
    var offline = new HashMap<>(online);
    when(parent.getId()).thenReturn("preserved-sso"); when(parent.getRealm()).thenReturn(f.realm);
    when(parent.getAuthenticatedClientSessionByClient(anyString())).thenAnswer(call -> online.get(call.getArgument(0)));
    when(offlineParent.getAuthenticatedClientSessionByClient(anyString())).thenAnswer(call -> offline.get(call.getArgument(0)));
    when(attached.getUserSession()).thenReturn(parent); when(attached.getClient()).thenReturn(client.client);
    var provider = f.session.sessions(); var singleUse = f.session.singleUseObjects();
    doAnswer(call -> { online.remove(client.client.getId()); offline.remove(client.client.getId()); return null; })
        .when(provider).onClientRemoved(f.realm, client.client);
    when(provider.getUserSessionIfClientExists(f.realm, "preserved-sso", false, client.client.getId()))
        .thenAnswer(call -> online.containsKey(client.client.getId()) ? parent : null);
    when(provider.getUserSession(f.realm, "preserved-sso")).thenReturn(parent);
    var codes = new HashMap<String, Map<String, String>>();
    doAnswer(call -> { codes.put(call.getArgument(0), call.getArgument(2)); return null; }).when(singleUse).put(anyString(), anyLong(), anyMap());
    when(singleUse.remove(anyString())).thenAnswer(call -> codes.remove(call.getArgument(0)));
    var event = mock(EventBuilder.class, RETURNS_SELF);
    int expires = (int) java.time.Instant.now().plusSeconds(60).getEpochSecond();
    String baseline = OAuth2CodeParser.persistCode(f.session, attached, new OAuth2Code(UUID.randomUUID().toString(), expires, "nonce", "openid", "preserved-sso"));
    assertNotNull(OAuth2CodeParser.parseCode(f.session, baseline, f.realm, event).getClientSession());
    String unspent = OAuth2CodeParser.persistCode(f.session, attached, new OAuth2Code(UUID.randomUUID().toString(), expires, "nonce", "openid", "preserved-sso"));
    var response = f.resource.delete((String) view.get("clientId"), Map.of("version", view.get("version")));
    assertEquals(200, response.getStatus()); assertEquals(Map.of("clientId", view.get("clientId"), "deleted", true), response.getEntity());
    assertEquals("no-store", response.getHeaderString("Cache-Control"));
    assertNull(f.realm.getClientByClientId((String) view.get("clientId")));
    assertSame(other.client, f.realm.getClientByClientId((String) otherView.get("clientId")));
    assertEquals(Set.of(other.client.getId()), online.keySet()); assertEquals(Set.of(other.client.getId()), offline.keySet());
    assertNull(OAuth2CodeParser.parseCode(f.session, unspent, f.realm, event).getClientSession());
    verify(provider).onClientRemoved(f.realm, client.client);
    verify(f.session.authenticationSessions()).onClientRemoved(f.realm, client.client);
    verify(provider, never()).removeUserSession(any(), any()); verify(provider, never()).removeOfflineUserSession(any(), any());
    verify(f.session.users(), never()).removeUser(any(), any()); verify(f.realm, never()).removeRole(any());
    verify(f.realm, never()).removeClient(other.client.getId()); verify(client.client, never()).getSecret();
    var recreated = f.create("public");
    assertNotEquals(view.get("clientId"), recreated.get("clientId"));
    assertNotEquals(client.client.getId(), f.nativeClient(recreated).client.getId());
  }

  @Test void deleteRejectsMalformedStaleUnownedAndUnauthorizedRequestsBeforeMutation() {
    var f = new Fixture(); var view = f.create("public"); var client = f.nativeClient(view); String id = (String) view.get("clientId");
    assertThrows(BadRequestException.class, () -> f.resource.delete(id, Map.of()));
    assertThrows(BadRequestException.class, () -> f.resource.delete(id, Map.of("version", "malformed")));
    assertThrows(BadRequestException.class, () -> f.resource.delete(id, Map.of("version", view.get("version"), "force", true)));
    assertThrows(ClientErrorException.class, () -> f.resource.delete(id, Map.of("version", UUID.randomUUID().toString())));
    assertThrows(NotFoundException.class, () -> f.resource.delete("identity-admin-web", Map.of("version", view.get("version"))));
    f.grants.remove(f.roles.get("administrador"));
    assertThrows(ForbiddenException.class, () -> f.resource.delete(id, Map.of("version", view.get("version"))));
    f.grants.add(f.roles.get("administrador")); client.attributes.remove(ApplicationsResourceFactory.MANAGED);
    assertThrows(NotFoundException.class, () -> f.resource.delete(id, Map.of("version", view.get("version"))));
    verify(f.realm, never()).removeClient(anyString()); verify(f.session.sessions(), never()).onClientRemoved(any(), any());
    assertSame(client.client, f.realm.getClientByClientId(id));
  }

  @Test void deleteRejectsUnexpectedServiceAccountAndRollsBackNativeFailure() {
    var f = new Fixture(); var view = f.create("public"); var client = f.nativeClient(view); String id = (String) view.get("clientId");
    String internalId = client.client.getId();
    var unexpectedServiceAccount = mock(UserModel.class);
    when(f.session.users().getServiceAccount(client.client)).thenReturn(unexpectedServiceAccount);
    assertThrows(ClientErrorException.class, () -> f.resource.delete(id, Map.of("version", view.get("version"))));
    verify(f.realm, never()).removeClient(anyString()); verify(f.session.users(), never()).removeUser(any(), any());
    when(f.session.users().getServiceAccount(client.client)).thenReturn(null);
    doReturn(false).when(f.realm).removeClient(internalId);
    assertEquals(409, assertThrows(ClientErrorException.class, () -> f.resource.delete(id, Map.of("version", view.get("version")))).getResponse().getStatus());
    doThrow(new IllegalStateException("native removal failure")).when(f.realm).removeClient(internalId);
    assertThrows(IllegalStateException.class, () -> f.resource.delete(id, Map.of("version", view.get("version"))));
    verify(f.session.getTransactionManager(), atLeast(3)).setRollbackOnly();
    verify(f.session.sessions(), never()).onClientRemoved(any(), any());
    assertSame(client.client, f.realm.getClientByClientId(id));
  }

  @Test void corruptedMarkersConfigurationsAndNativeDriftFailClosed() {
    var f = new Fixture(); var view = f.create("public"); var client = f.nativeClient(view);
    client.attributes.put(ApplicationsResourceFactory.MANAGED, "future-version");
    assertTrue(ApplicationsResourceFactory.managed(client.client));
    assertThrows(ForbiddenException.class, () -> ApplicationsResourceFactory.rule(client.client, f.registry));
    client.attributes.put(ApplicationsResourceFactory.MANAGED, "v1"); String config = client.attributes.get(ApplicationsResourceFactory.CONFIG);
    client.attributes.put(ApplicationsResourceFactory.CONFIG, "malformed");
    assertThrows(ForbiddenException.class, () -> ApplicationsResourceFactory.rule(client.client, f.registry));
    client.attributes.put(ApplicationsResourceFactory.CONFIG, config); client.values.put("ServiceAccountsEnabled", true);
    assertThrows(ForbiddenException.class, () -> ApplicationsResourceFactory.rule(client.client, f.registry));
    client.values.put("ServiceAccountsEnabled", false); client.attributes.put("pkce.code.challenge.method", "plain");
    assertThrows(ForbiddenException.class, () -> ApplicationsResourceFactory.rule(client.client, f.registry));
    client.attributes.put("pkce.code.challenge.method", "S256"); when(f.roles.get(ATOM).isComposite()).thenReturn(true);
    assertThrows(ForbiddenException.class, () -> ApplicationsResourceFactory.rule(client.client, f.registry));
    client.attributes.remove(ApplicationsResourceFactory.MANAGED);
    assertNull(ApplicationsResourceFactory.rule(client.client, f.registry));
    assertThrows(NotFoundException.class, () -> f.resource.update((String) view.get("clientId"), f.update(view)));
  }

  @Test void linksOnlyExistingProfileAndEmailScopes() {
    var f = new Fixture();
    for (String name : List.of("profile", "email", "roles")) {
      var scope = mock(ClientScopeModel.class); when(scope.getId()).thenReturn(name); when(scope.getName()).thenReturn(name);
      when(scope.getProtocol()).thenReturn("openid-connect"); when(scope.getScopeMappingsStream()).thenAnswer(call -> Stream.empty()); f.scopes.add(scope);
    }
    var client = f.nativeClient(f.create("public")); assertEquals(Set.of("profile", "email"), client.defaults.keySet());
    assertTrue(client.optional.isEmpty());
  }
}
