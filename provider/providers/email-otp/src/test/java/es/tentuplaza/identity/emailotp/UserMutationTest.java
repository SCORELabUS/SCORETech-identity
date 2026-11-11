package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.util.List;
import java.util.Map;
import jakarta.ws.rs.BadRequestException;
import org.junit.jupiter.api.Test;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.UserModel;

class UserMutationTest {
  final KeycloakSession session = mock(KeycloakSession.class);
  @Test void profileCannotWriteAdministrativeFieldsOrProtectedAttributes() {
    for (String field : List.of("enabled", "email", "emailVerified", "username"))
      assertThrows(BadRequestException.class, () -> UserMutationResourceFactory.validate(session, Map.of(field, true), false));
    for (String attribute : List.of("tentuWooCustomerId", "tentuTermsAcceptedAt", "tentuRegistrationCompletedAt"))
      assertThrows(BadRequestException.class, () -> UserMutationResourceFactory.validate(session, Map.of("attributes", Map.of(attribute, List.of("injected"))), false));
  }
  @Test void rejectsInvalidShapesAndServerSideProfileInputs() {
    for (Map<String,Object> patch : List.<Map<String,Object>>of(
        Map.of("firstName", "X".repeat(101)), Map.of("firstName", "<script>"),
        Map.of("enabled", "true"), Map.of("attributes", Map.of("tentuAvatar", List.of(123))),
        Map.of("attributes", Map.of("tentuPhone", List.of("invalid")))))
      assertThrows(BadRequestException.class, () -> UserMutationResourceFactory.validate(session, patch, true));
  }
  @Test void patchTouchesOnlyExplicitFieldsAndSupportsAttributeRemoval() {
    var user = mock(UserModel.class);
    UserMutationResourceFactory.apply(user, Map.of("firstName", " Persona ", "attributes", Map.of("tentuAvatar", List.of("new"), "tentuPhone", List.of())));
    verify(user).setFirstName("Persona"); verify(user).setAttribute("tentuAvatar", List.of("new")); verify(user).removeAttribute("tentuPhone");
    verifyNoMoreInteractions(user);
  }
  @Test void accountPreferencesPatchPreservesOtherFields() {
    var user = mock(UserModel.class);
    var patch = Map.<String,Object>of("attributes", Map.of("tentuPreferences", List.of("{\"theme\":\"dark\",\"email\":false,\"boe\":true}")));
    assertDoesNotThrow(() -> UserMutationResourceFactory.validate(session, patch, false));
    UserMutationResourceFactory.apply(user, patch);
    verify(user).setAttribute("tentuPreferences", List.of("{\"theme\":\"dark\",\"email\":false,\"boe\":true}"));
    verifyNoMoreInteractions(user);
  }
  @Test void accountCanChangeMarketingConsentWithoutChangingRegistrationEvidence() {
    for (String consent : List.of("true", "false")) {
      var user = mock(UserModel.class);
      var patch = Map.<String,Object>of("attributes", Map.of("tentuMarketing", List.of(consent)));
      assertDoesNotThrow(() -> UserMutationResourceFactory.validate(session, patch, false));
      UserMutationResourceFactory.apply(user, patch);
      verify(user).setAttribute("tentuMarketing", List.of(consent));
      verifyNoMoreInteractions(user);
    }
    for (List<String> value : List.<List<String>>of(List.of(), List.of("yes"), List.of("TRUE"), List.of("true", "false")))
      assertThrows(BadRequestException.class, () -> UserMutationResourceFactory.validate(session, Map.of("attributes", Map.of("tentuMarketing", value)), false));
  }
  @Test void accountCanPatchOnlySharedProfileGroupsWithoutReplacingOtherState() {
    var user = mock(UserModel.class);
    var patch = Map.<String,Object>of("attributes", Map.of("scoreProfile", List.of("{\"displayName\":\"Researcher\"}"), "scoreSocialLinks", List.of("{\"x\":\"https://x.com/researcher\"}")));
    assertDoesNotThrow(() -> UserMutationResourceFactory.validate(session, patch, false));
    UserMutationResourceFactory.apply(user, patch);
    verify(user).setAttribute("scoreProfile", List.of("{\"displayName\":\"Researcher\"}"));
    verify(user).setAttribute("scoreSocialLinks", List.of("{\"x\":\"https://x.com/researcher\"}"));
    verifyNoMoreInteractions(user);
  }
  @Test void emailChangeAlwaysInvalidatesVerificationAndLeavesUsernameStable() {
    var user = mock(UserModel.class); when(user.getEmail()).thenReturn("old@example.invalid");
    UserMutationResourceFactory.apply(user, Map.of("email", "NEW@example.invalid", "emailVerified", true));
    verify(user).setEmail("new@example.invalid"); verify(user).setEmailVerified(false);
    verify(user, never()).setUsername(anyString());
  }
  @Test void profileDefaultsFillMissingAttributesOnly() {
    var user = mock(UserModel.class);
    when(user.getFirstAttribute("scoreProfile")).thenReturn("{\"displayName\":\"Edited\"}");
    var defaults = Map.<String,Object>of("attributeDefaults", Map.of("scoreProfile", List.of("{}"),
        "tentuAvatar", List.of("{\"kind\":\"initials\"}")));
    assertDoesNotThrow(() -> UserMutationResourceFactory.validate(session, defaults, false));
    UserMutationResourceFactory.apply(user, defaults);
    verify(user, never()).setAttribute(eq("scoreProfile"), anyList());
    verify(user).setAttribute("tentuAvatar", List.of("{\"kind\":\"initials\"}"));
    assertThrows(BadRequestException.class, () -> UserMutationResourceFactory.validate(session,
        Map.of("attributeDefaults", Map.of("tentuTermsAcceptedAt", List.of("injected"))), false));
  }
}
