package es.tentuplaza.identity.emailotp;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;
import org.keycloak.models.*;
import org.keycloak.email.EmailTemplateProvider;
import org.keycloak.events.*;
import java.util.Map;
class SecurityEventsTest {
  @Test void notificationToPreviousAddressAllowsNativeRendererToEnrichAttributes() throws Exception {
    var session=mock(KeycloakSession.class,RETURNS_DEEP_STUBS);
    var realm=session.realms().getRealm("realm");
    var user=mock(UserModel.class);when(user.getEmail()).thenReturn("new@example.invalid");
    when(session.users().getUserById(realm,"user")).thenReturn(user);
    var mail=mock(EmailTemplateProvider.class);doReturn(mail).when(session).getProvider(EmailTemplateProvider.class);
    when(mail.setRealm(realm)).thenReturn(mail);when(mail.setUser(any())).thenReturn(mail);
    doAnswer(i->{Map<String,Object> attrs=i.getArgument(2);attrs.put("realmName","TenTuPlaza");return null;}).when(mail).send(eq("tentuEmailChangedSubject"),eq("email-changed.ftl"),anyMap());
    var event=new Event();event.setType(EventType.UPDATE_EMAIL);event.setRealmId("realm");event.setUserId("user");event.setDetails(Map.of(Details.PREVIOUS_EMAIL,"old@example.invalid"));
    new SecurityEventsFactory().create(session).onEvent(event);
    verify(mail).setUser(argThat(u->u.getEmail().equals("old@example.invalid")));
    verify(mail).send(eq("tentuEmailChangedSubject"),eq("email-changed.ftl"),anyMap());
  }
}
