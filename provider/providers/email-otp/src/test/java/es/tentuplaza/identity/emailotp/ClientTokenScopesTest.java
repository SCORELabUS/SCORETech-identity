package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import jakarta.ws.rs.BadRequestException;
import jakarta.ws.rs.ClientErrorException;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.keycloak.models.*;

class ClientTokenScopesTest {
  static final String ACCESS = "analytics:production:access";
  static final String VIEW = "analytics:view:overview";

  static ClientTokenScopes.Scope scope(String id, String... permissions) {
    var scope = new ClientTokenScopes.Scope(); scope.clientId = id;
    scope.permissions = List.of(permissions); return scope;
  }

  static RoleModel role(String name) {
    var role = mock(RoleModel.class); when(role.getName()).thenReturn(name); return role;
  }

  static final class Fixture {
    final RealmModel realm = mock(RealmModel.class);
    final ClientModel client = mock(ClientModel.class);
    final Map<String, String> attributes = new HashMap<>(Map.of("unrelated", "preserved"));
    final Set<RoleModel> direct = new LinkedHashSet<>();
    final Map<String, ClientScopeModel> defaults = new HashMap<>(), optional = new HashMap<>();
    final AtomicBoolean fullScope = new AtomicBoolean(true);
    final RoleModel access = role(ACCESS), view = role(VIEW);
    Fixture() {
      when(realm.getClientByClientId("analytics-web")).thenReturn(client);
      when(realm.getRole(ACCESS)).thenReturn(access); when(realm.getRole(VIEW)).thenReturn(view);
      when(client.getAttribute(anyString())).thenAnswer(call -> attributes.get(call.getArgument(0)));
      doAnswer(call -> { attributes.put(call.getArgument(0), call.getArgument(1)); return null; })
          .when(client).setAttribute(anyString(), anyString());
      doAnswer(call -> { attributes.remove(call.getArgument(0)); return null; })
          .when(client).removeAttribute(anyString());
      when(client.getScopeMappingsStream()).thenAnswer(call -> direct.stream());
      when(client.getClientScopes(true)).thenReturn(defaults);
      when(client.getClientScopes(false)).thenReturn(optional);
      doAnswer(call -> { direct.add(call.getArgument(0)); return null; })
          .when(client).addScopeMapping(any(RoleModel.class));
      doAnswer(call -> { direct.remove(call.getArgument(0)); return null; })
          .when(client).deleteScopeMapping(any(RoleModel.class));
      doAnswer(call -> { fullScope.set(call.getArgument(0)); return null; })
          .when(client).setFullScopeAllowed(anyBoolean());
    }
    void linked(boolean defaultScope, RoleModel role) {
      var linked = mock(ClientScopeModel.class);
      when(linked.getScopeMappingsStream()).thenAnswer(call -> java.util.stream.Stream.of(role));
      (defaultScope ? defaults : optional).put("linked", linked);
    }
    void apply(ClientTokenScopes.Scope scope) {
      ClientTokenScopes.reconcile(realm, List.of(scope), null);
    }
  }

  @Test void validatesAtomicPermissionsDuplicatesAndProtectedClients() {
    var valid = scope("analytics-web", ACCESS, VIEW);
    assertDoesNotThrow(() -> ClientTokenScopes.validate(List.of(valid), Set.of(ACCESS, VIEW)));
    assertDoesNotThrow(() -> ClientTokenScopes.validate(null, Set.of()));
    assertThrows(BadRequestException.class, () -> ClientTokenScopes.validate(List.of(valid, valid), Set.of(ACCESS, VIEW)));
    for (String client : List.of("account", "account-console", "admin-cli", "security-admin-console",
        "identity-config-sync", "identity-admin-service"))
      assertThrows(BadRequestException.class, () -> ClientTokenScopes.validate(List.of(scope(client)), Set.of()));
    assertThrows(BadRequestException.class, () -> ClientTokenScopes.validate(List.of(scope("analytics-web", "administrador")), Set.of("administrador")));
    assertThrows(BadRequestException.class, () -> ClientTokenScopes.validate(List.of(scope("analytics-web", VIEW)), Set.of(ACCESS)));
    assertThrows(BadRequestException.class, () -> ClientTokenScopes.validate(List.of(scope("analytics-web", ACCESS, ACCESS)), Set.of(ACCESS)));
    valid.enabled = false;
    assertThrows(BadRequestException.class, () -> ClientTokenScopes.validate(List.of(valid), Set.of(ACCESS, VIEW)));
  }

  @Test void preflightsAllClientsBeforeChangingAnyClient() {
    var fixture = new Fixture();
    assertThrows(ClientErrorException.class, () -> ClientTokenScopes.reconcile(fixture.realm,
        List.of(scope("analytics-web", ACCESS), scope("unknown-web", VIEW)), null));
    verify(fixture.client, never()).setFullScopeAllowed(anyBoolean());
    assertTrue(fixture.direct.isEmpty());
    assertEquals(Map.of("unrelated", "preserved"), fixture.attributes);
  }

  @Test void restrictsWithoutChangingUnrelatedAttributesOrRoleDefinitions() {
    var fixture = new Fixture(); fixture.apply(scope("analytics-web", ACCESS, VIEW));
    assertFalse(fixture.fullScope.get());
    assertEquals(Set.of(fixture.access, fixture.view), fixture.direct);
    assertEquals("preserved", fixture.attributes.get("unrelated"));
    assertEquals("[\"analytics:production:access\",\"analytics:view:overview\"]", fixture.attributes.get(ClientTokenScopes.OWNED));
    verify(fixture.realm, never()).removeRole(any(RoleModel.class));
    verify(fixture.access, never()).addCompositeRole(any(RoleModel.class));
  }

  @Test void retiresOnlyOwnedMappingsAndIsIdempotent() {
    var fixture = new Fixture(); var original = scope("analytics-web", ACCESS, VIEW);
    fixture.apply(original);
    var reduced = scope("analytics-web", ACCESS);
    ClientTokenScopes.reconcile(fixture.realm, List.of(reduced), List.of(original));
    ClientTokenScopes.reconcile(fixture.realm, List.of(reduced), List.of(reduced));
    assertEquals(Set.of(fixture.access), fixture.direct);
    assertEquals("[\"analytics:production:access\"]", fixture.attributes.get(ClientTokenScopes.OWNED));
    verify(fixture.client, times(1)).deleteScopeMapping(fixture.view);
    verify(fixture.client, times(1)).addScopeMapping(fixture.access);
  }

  @Test void neverClaimsAnExistingUnrelatedMappingEvenWhenCurrentlyAllowed() {
    var fixture = new Fixture(); fixture.direct.add(fixture.access);
    fixture.apply(scope("analytics-web", ACCESS));
    assertEquals("[]", fixture.attributes.get(ClientTokenScopes.OWNED));
    assertThrows(ClientErrorException.class, () -> fixture.apply(scope("analytics-web")));
    verify(fixture.client, never()).deleteScopeMapping(any(RoleModel.class));
    assertEquals(Set.of(fixture.access), fixture.direct);
  }

  @Test void ruleClientRejectsManualMatchingPermissionBeforeAnyMutation() {
    var fixture = new Fixture(); fixture.direct.add(fixture.access);
    var error = assertThrows(ClientErrorException.class,
        () -> ClientTokenScopes.preflightRuleClient(fixture.client));
    assertEquals(409, error.getResponse().getStatus());
    assertTrue(error.getMessage().contains("dedicated clean client"));
    assertEquals(Set.of(fixture.access), fixture.direct);
    assertEquals(Map.of("unrelated", "preserved"), fixture.attributes);
    verify(fixture.client, never()).setFullScopeAllowed(anyBoolean());
    verify(fixture.client, never()).setAttribute(anyString(), anyString());
    verify(fixture.client, never()).addScopeMapping(any(RoleModel.class));
    verify(fixture.client, never()).deleteScopeMapping(any(RoleModel.class));
  }

  @Test void ruleClientRejectsBothLinkedScopeKindsEvenWhenTheirPermissionWouldMatch() {
    for (boolean defaults : List.of(true, false)) {
      var fixture = new Fixture(); fixture.linked(defaults, fixture.access);
      assertThrows(ClientErrorException.class,
          () -> ClientTokenScopes.preflightRuleClient(fixture.client));
      verify(fixture.client, never()).setFullScopeAllowed(anyBoolean());
      verify(fixture.client, never()).setAttribute(anyString(), anyString());
      verify(fixture.client, never()).addScopeMapping(any(RoleModel.class));
      verify(fixture.client, never()).deleteScopeMapping(any(RoleModel.class));
    }
  }

  @Test void ruleClientAllowsExistingOwnedMappingsForIdempotenceReductionAndEmptyRetirement() {
    var fixture = new Fixture(); fixture.apply(scope("analytics-web", ACCESS, VIEW));
    clearInvocations(fixture.client);
    assertDoesNotThrow(() -> ClientTokenScopes.preflightRuleClient(fixture.client));
    verify(fixture.client, never()).setAttribute(anyString(), anyString());
    verify(fixture.client, never()).setFullScopeAllowed(anyBoolean());
    fixture.apply(scope("analytics-web", ACCESS));
    assertDoesNotThrow(() -> ClientTokenScopes.preflightRuleClient(fixture.client));
    assertEquals(Set.of(fixture.access), fixture.direct);
    fixture.apply(scope("analytics-web"));
    assertDoesNotThrow(() -> ClientTokenScopes.preflightRuleClient(fixture.client));
    assertTrue(fixture.direct.isEmpty());
    assertFalse(fixture.fullScope.get());
    assertEquals("[]", fixture.attributes.get(ClientTokenScopes.OWNED));
  }

  @Test void ruleClientAllowsOnlyAtomicRealmTechnicalMappingsAndValidOwnedPermissions() {
    assertDoesNotThrow(() -> ClientTokenScopes.preflightRuleClient(new Fixture().client));
    for (boolean linked : List.of(true, false)) {
      for (String name : List.of("offline_access", "uma_authorization")) {
        var fixture = new Fixture(); var technical = role(name);
        if (linked) fixture.linked(false, technical); else fixture.direct.add(technical);
        assertDoesNotThrow(() -> ClientTokenScopes.preflightRuleClient(fixture.client));
        when(technical.isComposite()).thenReturn(true);
        assertThrows(ClientErrorException.class,
            () -> ClientTokenScopes.preflightRuleClient(fixture.client));
        when(technical.isComposite()).thenReturn(false); when(technical.isClientRole()).thenReturn(true);
        assertThrows(ClientErrorException.class,
            () -> ClientTokenScopes.preflightRuleClient(fixture.client));
      }
    }
    var malformed = new Fixture(); malformed.attributes.put(ClientTokenScopes.OWNED, "[\"administrador\"]");
    assertThrows(ClientErrorException.class,
        () -> ClientTokenScopes.preflightRuleClient(malformed.client));
    var composite = new Fixture(); composite.apply(scope("analytics-web", ACCESS));
    when(composite.access.isComposite()).thenReturn(true);
    assertThrows(ClientErrorException.class,
        () -> ClientTokenScopes.preflightRuleClient(composite.client));
  }

  @Test void rejectsUnrelatedDirectClientRolesAndCompositeMappings() {
    for (String kind : List.of("other-permission", "client-role", "composite")) {
      var fixture = new Fixture();
      var widening = role(kind.equals("other-permission") ? "identity:users:delete" : ACCESS);
      if (kind.equals("client-role")) when(widening.isClientRole()).thenReturn(true);
      if (kind.equals("composite")) when(widening.isComposite()).thenReturn(true);
      fixture.direct.add(widening);
      assertThrows(ClientErrorException.class, () -> fixture.apply(scope("analytics-web", ACCESS)));
      verify(fixture.client, never()).setFullScopeAllowed(anyBoolean());
      verify(fixture.client, never()).deleteScopeMapping(any(RoleModel.class));
    }
  }

  static RoleModel nativeLinks(Fixture fixture, String name) {
    var account = mock(ClientModel.class);
    when(account.getId()).thenReturn("native-account-id");
    when(fixture.realm.getClientByClientId("account")).thenReturn(account);
    when(fixture.realm.getClientByClientId("identity-account-web")).thenReturn(fixture.client);
    var links = role(name);
    when(links.isClientRole()).thenReturn(true);
    when(links.getContainerId()).thenReturn("native-account-id");
    return links;
  }

  @Test void preservesOnlyTheDirectNativeAccountLinkScopeOnAccountWeb() {
    var fixture = new Fixture();
    var links = nativeLinks(fixture, "manage-account-links");
    fixture.direct.add(links);
    fixture.apply(scope("identity-account-web"));
    fixture.apply(scope("identity-account-web"));
    assertFalse(fixture.fullScope.get());
    assertEquals(Set.of(links), fixture.direct);
    assertEquals("[]", fixture.attributes.get(ClientTokenScopes.OWNED));
    verify(fixture.client, never()).deleteScopeMapping(links);
  }

  @Test void rejectsBroaderOrImpersonatedNativeScopesAndOtherConsumers() {
    for (String kind : List.of("other-consumer", "manage-account", "view-profile", "wrong-container", "composite", "missing-native-client")) {
      var fixture = new Fixture();
      var links = nativeLinks(fixture, Set.of("manage-account", "view-profile").contains(kind) ? kind : "manage-account-links");
      if (kind.equals("wrong-container")) when(links.getContainerId()).thenReturn("another-client");
      if (kind.equals("composite")) when(links.isComposite()).thenReturn(true);
      if (kind.equals("missing-native-client")) when(fixture.realm.getClientByClientId("account")).thenReturn(null);
      fixture.direct.add(links);
      assertThrows(ClientErrorException.class, () -> fixture.apply(scope(kind.equals("other-consumer") ? "analytics-web" : "identity-account-web")));
      verify(fixture.client, never()).setFullScopeAllowed(anyBoolean());
      verify(fixture.client, never()).deleteScopeMapping(any(RoleModel.class));
    }
  }

  @Test void keepsLinkedScopesAndAccessRuleClientsStrictDespiteNativeLinkScope() {
    for (boolean defaults : List.of(true, false)) {
      var fixture = new Fixture();
      var links = nativeLinks(fixture, "manage-account-links");
      fixture.linked(defaults, links);
      assertThrows(ClientErrorException.class, () -> fixture.apply(scope("identity-account-web")));
    }
    var fixture = new Fixture();
    fixture.direct.add(nativeLinks(fixture, "manage-account-links"));
    assertThrows(ClientErrorException.class, () -> ClientTokenScopes.preflightRuleClient(fixture.client));
  }

  @Test void rejectsWideningFromBothDefaultAndOptionalLinkedScopes() {
    for (boolean defaults : List.of(true, false)) {
      var fixture = new Fixture(); fixture.linked(defaults, role("identity:users:delete"));
      assertThrows(ClientErrorException.class, () -> fixture.apply(scope("analytics-web", ACCESS)));
      verify(fixture.client, never()).setFullScopeAllowed(anyBoolean());
    }
  }

  @Test void allowsOnlyAtomicRealmTechnicalMappingsFromStandardKeycloakScopes() {
    for (String name : List.of("offline_access", "uma_authorization")) {
      var fixture = new Fixture(); var technical = role(name); fixture.linked(false, technical);
      assertDoesNotThrow(() -> fixture.apply(scope("analytics-web", ACCESS)));
      when(technical.isComposite()).thenReturn(true);
      assertThrows(ClientErrorException.class, () -> fixture.apply(scope("analytics-web", ACCESS)));
      when(technical.isComposite()).thenReturn(false); when(technical.isClientRole()).thenReturn(true);
      assertThrows(ClientErrorException.class, () -> fixture.apply(scope("analytics-web", ACCESS)));
    }
  }

  @Test void failsForMissingOrCompositeDesiredPermissionBeforeMutation() {
    var fixture = new Fixture();
    assertThrows(ClientErrorException.class, () -> fixture.apply(scope("analytics-web", "analytics:unknown")));
    when(fixture.access.isComposite()).thenReturn(true);
    assertThrows(ClientErrorException.class, () -> fixture.apply(scope("analytics-web", ACCESS)));
    verify(fixture.client, never()).setFullScopeAllowed(anyBoolean());
  }

  @Test void legacySnapshotsAndOmittedClientsNeverReopenScopes() {
    var fixture = new Fixture(); var original = scope("analytics-web", ACCESS);
    fixture.apply(original); clearInvocations(fixture.client);
    ClientTokenScopes.reconcile(fixture.realm, null, List.of(original));
    ClientTokenScopes.reconcile(fixture.realm, List.of(), List.of(original));
    assertFalse(fixture.fullScope.get());
    verifyNoInteractions(fixture.client);
  }

  @Test void explicitRollbackRequiresOwnershipAndPreservesUnownedMappings() {
    var fixture = new Fixture(); var disabled = scope("analytics-web"); disabled.enabled = false;
    assertThrows(ClientErrorException.class, () -> fixture.apply(disabled));
    var original = scope("analytics-web", ACCESS); fixture.apply(original);
    var technical = role("offline_access"); fixture.direct.add(technical);
    ClientTokenScopes.reconcile(fixture.realm, List.of(disabled), List.of(original));
    assertTrue(fixture.fullScope.get());
    assertEquals(Set.of(technical), fixture.direct);
    assertFalse(fixture.attributes.containsKey(ClientTokenScopes.OWNED));
    assertEquals("preserved", fixture.attributes.get("unrelated"));
    assertDoesNotThrow(() -> ClientTokenScopes.reconcile(fixture.realm, List.of(disabled), List.of(disabled)));
  }

  @Test void malformedOwnershipMarkerCannotCauseScopeDeletion() {
    var fixture = new Fixture(); fixture.direct.add(fixture.access);
    fixture.attributes.put(ClientTokenScopes.OWNED, "[\"administrador\"]");
    assertThrows(ClientErrorException.class, () -> fixture.apply(scope("analytics-web", ACCESS)));
    verify(fixture.client, never()).deleteScopeMapping(any(RoleModel.class));
    verify(fixture.client, never()).setFullScopeAllowed(anyBoolean());
  }
}
