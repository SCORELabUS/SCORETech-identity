package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import jakarta.ws.rs.core.MultivaluedHashMap;
import java.util.HashMap;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.keycloak.authentication.AuthenticationFlowContext;

class RegistrationNoticeTest {
  private AuthenticationFlowContext context(MultivaluedHashMap<String, String> query) {
    var context = mock(AuthenticationFlowContext.class, RETURNS_DEEP_STUBS);
    var notes = new HashMap<String, String>();
    when(context.getUriInfo().getQueryParameters()).thenReturn(query);
    var auth = context.getAuthenticationSession();
    when(auth.getAuthNote(anyString())).thenAnswer(call -> notes.get(call.getArgument(0)));
    doAnswer(call -> { notes.put(call.getArgument(0), call.getArgument(1)); return null; })
        .when(auth).setAuthNote(anyString(), anyString());
    return context;
  }

  @Test void hidesNoticeWithoutExplicitExactRequest() {
    for (var values : List.<List<String>>of(List.of(), List.of(""), List.of("true"),
        List.of("CONFIDENTIALITY"), List.of("confidentiality", "confidentiality"),
        List.of("confidentiality", "other"))) {
      var query = new MultivaluedHashMap<String, String>();
      if (!values.isEmpty()) query.put(RegistrationNotice.PARAMETER, values);
      var context = context(query);
      RegistrationNotice.capture(context);
      assertFalse(RegistrationNotice.enabled(context));
    }
  }

  @Test void retainsExplicitOptInAcrossOtpAndRegistrationRetries() {
    var query = new MultivaluedHashMap<String, String>();
    query.putSingle(RegistrationNotice.PARAMETER, RegistrationNotice.CONFIDENTIALITY);
    var context = context(query);
    RegistrationNotice.capture(context);
    assertTrue(RegistrationNotice.enabled(context));
    query.clear(); // Subsequent OTP/register form actions no longer carry the parameter.
    RegistrationNotice.capture(context);
    assertTrue(RegistrationNotice.enabled(context));
  }

  @Test void ignoresLateParametersAndDoesNotLeakIntoAnotherTransaction() {
    var query = new MultivaluedHashMap<String, String>();
    var first = context(query);
    RegistrationNotice.capture(first);
    query.putSingle(RegistrationNotice.PARAMETER, RegistrationNotice.CONFIDENTIALITY);
    RegistrationNotice.capture(first);
    assertFalse(RegistrationNotice.enabled(first));
    var optedIn = context(query);
    RegistrationNotice.capture(optedIn);
    assertTrue(RegistrationNotice.enabled(optedIn));
    query.clear();
    var next = context(query);
    RegistrationNotice.capture(next);
    assertFalse(RegistrationNotice.enabled(next));
  }
}
