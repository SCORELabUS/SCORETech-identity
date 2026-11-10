package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import jakarta.ws.rs.BadRequestException;
import jakarta.ws.rs.ClientErrorException;
import jakarta.ws.rs.ForbiddenException;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.keycloak.models.*;

class ClientAccessRulesTest {
  static final String ACCESS = "analytics:production:access";
  static final String VIEW = "analytics:view:overview";
  static final String ORIGIN = "https://analytics.score.us.es";

  static ClientAccessRules.Rule rule(String id, String client, String origin, String... permissions) {
    var result = new ClientAccessRules.Rule(); result.id = id; result.clientId = client;
    result.origin = origin; result.requiredPermissions = List.of(permissions); return result;
  }

  static ClientAccessRules.Rule valid() { return rule("analytics", "analytics-web", ORIGIN, ACCESS, VIEW); }

  static final class Fixture {
    final RealmModel realm = mock(RealmModel.class);
    final ClientModel client = mock(ClientModel.class);
    final UserModel user = mock(UserModel.class);
    final RoleModel access = mock(RoleModel.class), view = mock(RoleModel.class);
    final Set<RoleModel> grants = new HashSet<>();
    final List<ProtocolMapperModel> mappers = new ArrayList<>();
    Fixture() {
      when(realm.getClientByClientId("analytics-web")).thenReturn(client);
      when(realm.getRole(ACCESS)).thenReturn(access); when(realm.getRole(VIEW)).thenReturn(view);
      when(client.getClientId()).thenReturn("analytics-web"); when(client.isEnabled()).thenReturn(true);
      when(client.getProtocol()).thenReturn("openid-connect"); when(client.isStandardFlowEnabled()).thenReturn(true);
      when(client.getRedirectUris()).thenReturn(Set.of(ORIGIN + "/callback", ORIGIN + "/verification-callback"));
      when(client.getProtocolMappersStream()).thenAnswer(call -> mappers.stream());
      when(client.addProtocolMapper(any())).thenAnswer(call -> { var mapper = (ProtocolMapperModel) call.getArgument(0); mappers.add(mapper); return mapper; });
      when(user.isEnabled()).thenReturn(true);
      when(user.hasRole(any())).thenAnswer(call -> grants.contains(call.getArgument(0)));
      grants.addAll(List.of(access, view));
      registry("production", valid());
    }
    void registry(String environment, ClientAccessRules.Rule... rules) {
      var registry = new AuthorizationResourceFactory.Registry(); registry.environment = environment;
      registry.accessRules = List.of(rules);
      for (String name : List.of(ACCESS, VIEW)) {
        var permission = new AuthorizationResourceFactory.Permission(); permission.name = name; permission.owner = "analytics-api";
        registry.permissions.add(permission);
      }
      when(realm.getAttribute(AuthorizationResourceFactory.ACTIVE)).thenReturn(AuthorizationResourceFactory.serialize(registry));
    }
    void enforce(String redirect) { ClientAccessRules.enforce(realm, user, client, redirect); }
  }

  @Test void validatesCanonicalOriginsAndAllowsHttpLoopbackOnlyLocally() {
    assertDoesNotThrow(() -> ClientAccessRules.validate(List.of(valid()), Set.of(ACCESS, VIEW), "production"));
    for (String origin : List.of("http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080")) {
      var local = rule("local", "analytics-web", origin, ACCESS);
      assertDoesNotThrow(() -> ClientAccessRules.validate(List.of(local), Set.of(ACCESS), "local"));
      assertThrows(BadRequestException.class, () -> ClientAccessRules.validate(List.of(local), Set.of(ACCESS), "production"));
    }
    for (String origin : List.of("https://analytics.score.us.es/", "https://analytics.score.us.es/path",
        "https://analytics.score.us.es?x=1", "https://analytics.score.us.es#x", "https://user@analytics.score.us.es",
        "https://*.score.us.es", "https://analytics.score.us.es.", "https://analytics.score.us.es:443",
        "https://ANALYTICS.score.us.es", "http://analytics.score.us.es", "http://127.0.0.2:8080",
        "//analytics.score.us.es", "https://analytics.score.us.es:", "https://analytics.score.us.es:65536"))
      assertThrows(BadRequestException.class, () -> ClientAccessRules.validate(
          List.of(rule("test", "analytics-web", origin, ACCESS)), Set.of(ACCESS), "production"), origin);
  }

  @Test void rejectsDuplicateIdsClientsUnknownPermissionsAndEmptyRequirements() {
    for (var rules : List.of(List.of(valid(), valid()),
        List.of(valid(), rule("other", "analytics-web", ORIGIN, ACCESS)),
        List.of(valid(), rule("analytics", "other-web", ORIGIN, ACCESS)),
        List.of(rule("empty", "analytics-web", ORIGIN)),
        List.of(rule("unknown", "analytics-web", ORIGIN, "analytics:unknown")),
        List.of(rule("duplicate", "analytics-web", ORIGIN, ACCESS, ACCESS)),
        List.of(rule("admin", "analytics-web", ORIGIN, "administrador"))))
      assertThrows(BadRequestException.class, () -> ClientAccessRules.validate(rules, Set.of(ACCESS, VIEW), "production"));
    assertThrows(BadRequestException.class, () -> ClientAccessRules.validate(Collections.nCopies(251, valid()), Set.of(ACCESS, VIEW), "production"));
    var excessive = valid(); excessive.requiredPermissions = Collections.nCopies(1001, ACCESS);
    assertThrows(BadRequestException.class, () -> ClientAccessRules.validate(List.of(excessive), Set.of(ACCESS), "production"));
  }

  @Test void rejectsProtectedAndIdentityClients() {
    for (String client : List.of("account", "account-console", "admin-cli", "security-admin-console",
        "realm-management", "broker", "identity-admin-web", "identity-account-web", "identity-config-sync"))
      assertThrows(BadRequestException.class, () -> ClientAccessRules.validate(
          List.of(rule("test", client, ORIGIN, ACCESS)), Set.of(ACCESS), "production"));
  }

  @Test void rejectsUnknownDisabledNonOidcMachineAndNonStandardClients() {
    var unknown = rule("unknown", "unknown-web", ORIGIN, ACCESS);
    assertThrows(ClientErrorException.class, () -> ClientAccessRules.preflight(new Fixture().realm, List.of(unknown)));
    for (String kind : List.of("disabled", "saml", "machine", "non-standard")) {
      var f = new Fixture();
      if (kind.equals("disabled")) when(f.client.isEnabled()).thenReturn(false);
      if (kind.equals("saml")) when(f.client.getProtocol()).thenReturn("saml");
      if (kind.equals("machine")) when(f.client.isServiceAccountsEnabled()).thenReturn(true);
      if (kind.equals("non-standard")) when(f.client.isStandardFlowEnabled()).thenReturn(false);
      assertThrows(ClientErrorException.class, () -> ClientAccessRules.reconcile(f.realm, List.of(valid())), kind);
      verify(f.client, never()).addProtocolMapper(any());
    }
  }

  @Test void checksAllClientsBeforeInstallingAnyMapper() {
    var f = new Fixture();
    assertThrows(ClientErrorException.class, () -> ClientAccessRules.reconcile(f.realm,
        List.of(valid(), rule("unknown", "unknown-web", ORIGIN, ACCESS))));
    verify(f.client, never()).addProtocolMapper(any());
  }

  @Test void permitsMultiplePathsAndDefaultPortsButRejectsOtherOriginsAndGlobs() {
    var valid = new Fixture();
    when(valid.client.getRedirectUris()).thenReturn(Set.of(ORIGIN + "/callback", ORIGIN + ":443/other"));
    assertDoesNotThrow(() -> ClientAccessRules.preflight(valid.realm, List.of(valid())));
    for (String callback : List.of("https://analytics.score.us.es.evil/callback", "https://other.score.us.es/callback",
        ORIGIN + ":444/callback", "http://analytics.score.us.es/callback", ORIGIN + "/*", "/callback", ORIGIN + "/callback#x")) {
      var f = new Fixture(); when(f.client.getRedirectUris()).thenReturn(Set.of(ORIGIN + "/callback", callback));
      assertThrows(ClientErrorException.class, () -> ClientAccessRules.preflight(f.realm, List.of(valid())), callback);
    }
  }

  @Test void installsOnlyMissingOwnedMappersIdempotentlyWithoutChangingCallbacksOrGrants() {
    var f = new Fixture();
    ClientAccessRules.reconcile(f.realm, List.of(valid()));
    assertEquals(3, f.mappers.size());
    assertTrue(f.mappers.stream().allMatch(mapper -> mapper.getName().startsWith(ClientAccessRules.OWNED_PREFIX)));
    var roles = f.mappers.stream().filter(mapper -> mapper.getProtocolMapper().equals("oidc-usermodel-realm-role-mapper")).findFirst().orElseThrow();
    assertEquals("true", roles.getConfig().get("multivalued"));
    assertEquals("realm_access.roles", roles.getConfig().get("claim.name"));
    var audience = f.mappers.stream().filter(mapper -> mapper.getProtocolMapper().equals("oidc-audience-mapper")).findFirst().orElseThrow();
    assertEquals("analytics-web", audience.getConfig().get("included.custom.audience"));
    ClientAccessRules.reconcile(f.realm, List.of(valid()));
    assertEquals(3, f.mappers.size());
    verify(f.client, never()).setRedirectUris(any()); verify(f.client, never()).setFullScopeAllowed(anyBoolean());
    verify(f.user, never()).grantRole(any()); verify(f.realm, never()).addClient(anyString());
  }

  @Test void mapperNameCollisionFailsBeforeAnyMutation() {
    var f = new Fixture(); var collision = new ProtocolMapperModel();
    collision.setName(ClientAccessRules.OWNED_PREFIX + "realm-roles"); collision.setProtocol("openid-connect");
    collision.setProtocolMapper("unrelated"); collision.setConfig(Map.of()); f.mappers.add(collision);
    assertThrows(ClientErrorException.class, () -> ClientAccessRules.reconcile(f.realm, List.of(valid())));
    verify(f.client, never()).addProtocolMapper(any());
  }

  @Test void preservesEquivalentUnownedMappersButDoesNotMistakePrefixedRolesForRequiredClaims() {
    var f = new Fixture();
    ClientAccessRules.reconcile(f.realm, List.of(valid()));
    f.mappers.forEach(mapper -> mapper.setName("existing-" + mapper.getProtocolMapper()));
    ClientAccessRules.reconcile(f.realm, List.of(valid()));
    assertEquals(3, f.mappers.size());
    var roles = f.mappers.stream().filter(mapper -> mapper.getProtocolMapper().equals("oidc-usermodel-realm-role-mapper")).findFirst().orElseThrow();
    roles.getConfig().put("usermodel.realmRoleMapping.rolePrefix", "unrelated-");
    ClientAccessRules.reconcile(f.realm, List.of(valid()));
    assertEquals(4, f.mappers.size());
    assertEquals("unrelated-", roles.getConfig().get("usermodel.realmRoleMapping.rolePrefix"));
    assertTrue(f.mappers.stream().anyMatch(mapper -> mapper.getName().equals(ClientAccessRules.OWNED_PREFIX + "realm-roles")));
  }

  @Test void usesCurrentEffectiveRolesAndRejectsRefreshAfterRevocation() {
    var f = new Fixture(); assertDoesNotThrow(() -> f.enforce(ORIGIN + "/callback"));
    f.grants.remove(f.view);
    assertThrows(ForbiddenException.class, () -> f.enforce(ORIGIN + "/callback"));
    f.grants.add(f.view); assertDoesNotThrow(() -> f.enforce(ORIGIN + ":443/verification-callback"));
    when(f.view.isComposite()).thenReturn(true);
    assertThrows(ForbiddenException.class, () -> f.enforce(ORIGIN + "/callback"));
  }

  @Test void missingRefreshRedirectSuffixMatchingAndUnknownContextFailClosed() {
    var f = new Fixture();
    for (String redirect : Arrays.asList(null, "", "https://analytics.score.us.es.evil/callback", ORIGIN + ":444/callback"))
      assertThrows(ForbiddenException.class, () -> f.enforce(redirect));
    assertThrows(ForbiddenException.class, () -> ClientAccessRules.enforce(f.realm, f.user, null, ORIGIN + "/callback"));
    assertThrows(ForbiddenException.class, () -> ClientAccessRules.enforce(f.realm, null, f.client, ORIGIN + "/callback"));
    when(f.user.getServiceAccountClientLink()).thenReturn("machine-client");
    assertThrows(ForbiddenException.class, () -> f.enforce(ORIGIN + "/callback"));
  }

  @Test void leavesUnmanagedIdentityClientsToTheirExistingPolicies() {
    var f = new Fixture(); var account = mock(ClientModel.class);
    when(account.getClientId()).thenReturn("identity-account-web");
    assertDoesNotThrow(() -> ClientAccessRules.enforce(f.realm, null, account, null));
  }
  @Test void managedApplicationsCannotBypassAdmissionWhenTheLegacyRuleListIsEmpty() {
    var fixture = new Fixture(); fixture.registry("production");
    when(fixture.client.getAttribute(ApplicationsResourceFactory.MANAGED)).thenReturn("v1");
    when(fixture.client.getAttribute(ApplicationsResourceFactory.CONFIG)).thenReturn("{}");
    assertThrows(jakarta.ws.rs.ForbiddenException.class, () -> fixture.enforce(ORIGIN + "/callback"));
  }

  @Test void managedApplicationsFailClosedWithoutAnAppliedRegistry() {
    var fixture = new Fixture();
    when(fixture.realm.getAttribute(AuthorizationResourceFactory.ACTIVE)).thenReturn(null);
    when(fixture.client.getAttribute(ApplicationsResourceFactory.MANAGED)).thenReturn("v1");
    assertThrows(jakarta.ws.rs.ForbiddenException.class, () -> fixture.enforce(ORIGIN + "/callback"));
  }

  @Test void missingClientContextFailsClosedWhenManagedApplicationsExistWithoutLegacyRules() {
    var fixture = new Fixture(); fixture.registry("production");
    when(fixture.client.getAttribute(ApplicationsResourceFactory.MANAGED)).thenReturn("unknown-version");
    when(fixture.realm.getClientsStream()).thenAnswer(call -> java.util.stream.Stream.of(fixture.client));
    assertThrows(jakarta.ws.rs.ForbiddenException.class,
        () -> ClientAccessRules.enforce(fixture.realm, fixture.user, null, ORIGIN + "/callback"));
  }

}
