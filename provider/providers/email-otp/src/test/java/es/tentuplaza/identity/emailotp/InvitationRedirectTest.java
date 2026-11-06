package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.net.URI;
import java.util.Set;
import jakarta.ws.rs.ServiceUnavailableException;
import org.junit.jupiter.api.Test;
import org.keycloak.models.ClientModel;

class InvitationRedirectTest {
  final ClientModel client=mock(ClientModel.class);
  final URI staging=URI.create("https://staging-identity.example.test/realms/tentuplaza");
  final String local="http://localhost:5174/auth/callback";
  final String portal="https://staging-id.example.test/auth/callback";
  @Test void deployedInvitationIgnoresEarlierLocalCallback() {
    when(client.getRedirectUris()).thenReturn(Set.of(local,portal));
    assertEquals(portal,InvitationResourceFactory.portalCallback(client,staging));
  }
  @Test void localFixtureKeepsItsLocalCallback() {
    when(client.getRedirectUris()).thenReturn(Set.of(local,portal));
    assertEquals(local,InvitationResourceFactory.portalCallback(client,URI.create("http://localhost:28080")));
  }
  @Test void deployedRealmCannotFallBackToLocalhostOrInsecurePortal() {
    when(client.getRedirectUris()).thenReturn(Set.of(local,"http://staging-id.example.test/auth/callback"));
    assertThrows(ServiceUnavailableException.class,()->InvitationResourceFactory.portalCallback(client,staging));
  }
  @Test void ambiguousOrWildcardDestinationsFailRatherThanChooseAnotherEnvironment() {
    when(client.getRedirectUris()).thenReturn(Set.of(portal,"https://id.example.test/auth/callback"));
    assertThrows(ServiceUnavailableException.class,()->InvitationResourceFactory.portalCallback(client,staging));
    when(client.getRedirectUris()).thenReturn(Set.of("https://*.example.test/auth/callback", "https://staging-id.example.test/auth/callback?next=local"));
    assertThrows(ServiceUnavailableException.class,()->InvitationResourceFactory.portalCallback(client,staging));
  }
}
