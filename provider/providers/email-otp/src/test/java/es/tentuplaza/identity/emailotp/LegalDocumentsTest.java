package es.tentuplaza.identity.emailotp;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import jakarta.ws.rs.ServiceUnavailableException;
import org.junit.jupiter.api.Test;
import org.keycloak.models.RealmModel;
class LegalDocumentsTest {
  @Test void legacyRegistrationHasNoInventedDigest() {
    var realm = mock(RealmModel.class);
    assertEquals("2026-09", LegalDocuments.value(realm, "terms", "version"));
    assertEquals("", LegalDocuments.value(realm, "terms", "digest"));
  }
  @Test void invalidConfiguredReferencesFailClosed() {
    var realm = mock(RealmModel.class);
    when(realm.getAttribute("tentu.legal.terms.url")).thenReturn("javascript:alert(1)");
    assertThrows(ServiceUnavailableException.class, () -> LegalDocuments.value(realm, "terms", "url"));
    assertTrue(LegalDocuments.validUrl("https://docs.tentuplaza.es/legal/terms/2026-10-22"));
    assertTrue(LegalDocuments.validUrl("http://localhost:3100/legal/terms/2026-10-22"));
    assertFalse(LegalDocuments.validUrl("http://docs.tentuplaza.es/legal"));
    assertFalse(LegalDocuments.validUrl("https://user:password@docs.tentuplaza.es/legal"));
  }
  @Test void renderedReferenceRemainsPinnedUntilRegistrationCompletes() {
    var realm = mock(RealmModel.class);
    var context = mock(org.keycloak.authentication.AuthenticationFlowContext.class);
    var authentication = mock(org.keycloak.sessions.AuthenticationSessionModel.class);
    var form = mock(org.keycloak.forms.login.LoginFormsProvider.class, RETURNS_SELF);
    var user = mock(org.keycloak.models.UserModel.class);
    var notes = new java.util.HashMap<String, String>();
    when(context.getRealm()).thenReturn(realm); when(context.getAuthenticationSession()).thenReturn(authentication);
    when(context.form()).thenReturn(form);
    when(authentication.getAuthNote(anyString())).thenAnswer(call -> notes.get(call.getArgument(0)));
    doAnswer(call -> { notes.put(call.getArgument(0), call.getArgument(1)); return null; })
        .when(authentication).setAuthNote(anyString(), anyString());
    for (String kind : new String[]{"terms", "privacy"}) {
      when(realm.getAttribute("tentu.legal." + kind + ".url")).thenReturn("https://docs.tentuplaza.es/legal/" + kind + "/v1/");
      when(realm.getAttribute("tentu.legal." + kind + ".version")).thenReturn("v1");
      when(realm.getAttribute("tentu.legal." + kind + ".digest")).thenReturn("sha256:" + "a".repeat(64));
    }
    LegalDocuments.present(context);
    when(realm.getAttribute("tentu.legal.terms.version")).thenReturn("v2");
    LegalDocuments.present(context); LegalDocuments.record(context, user);
    verify(user).setSingleAttribute("tentuTermsVersion", "v1");
    verify(user).setSingleAttribute("tentuTermsDigest", "sha256:" + "a".repeat(64));
    verify(form, times(2)).setAttribute("termsDocumentUrl", "https://docs.tentuplaza.es/legal/terms/v1/");
  }
}
