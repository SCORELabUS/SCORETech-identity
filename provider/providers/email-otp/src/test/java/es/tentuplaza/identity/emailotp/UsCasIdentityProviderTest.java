package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.keycloak.broker.provider.UserAuthenticationIdentityProvider;
import org.keycloak.models.IdentityProviderModel;

class UsCasIdentityProviderTest {
    @Test void callbackResourceIsStaticForKeycloakAugmentation() {
        assertTrue(java.lang.reflect.Modifier.isStatic(UsCasIdentityProviderFactory.Provider.Endpoint.class.getModifiers()));
    }
    private static final String START = "<cas:serviceResponse xmlns:cas='http://www.yale.edu/tp/cas'>";
    private static byte[] xml(String body) { return (START + body + "</cas:serviceResponse>").getBytes(StandardCharsets.UTF_8); }
    @Test void parsesAdasLowercaseAttributesAndStableUvusWithoutTrustingEmail() throws Exception {
        var profile = UsCasIdentityProviderFactory.parseProfile(xml("<cas:authenticationSuccess><cas:user>uvus123</cas:user><cas:attributes><cas:givenname>Anne &amp; Ana</cas:givenname><cas:schacSn1>First</cas:schacSn1><cas:schacSn2>Second</cas:schacSn2><cas:mail>anne@example.org</cas:mail></cas:attributes></cas:authenticationSuccess>"));
        assertEquals("uvus123", profile.id()); assertEquals("Anne & Ana", profile.firstName());
        assertEquals("First Second", profile.lastName()); assertEquals("anne@example.org", profile.email());
        var user = mock(org.keycloak.models.UserModel.class);
        new UsCasIdentityProviderFactory.Provider(null, new IdentityProviderModel()).importNewUser(null, null, user, null);
        verify(user).setEmailVerified(false);
    }
    @Test void absentEmailIsNotFabricated() throws Exception {
        assertNull(UsCasIdentityProviderFactory.parseProfile(xml("<cas:authenticationSuccess><cas:user>uvus</cas:user></cas:authenticationSuccess>")).email());
    }
    @Test void acceptsRepeatedOptionalAttributesWithoutChoosingBetweenConflictingEmails() throws Exception {
        var profile = UsCasIdentityProviderFactory.parseProfile(xml("""
            <cas:authenticationSuccess>
                <cas:user>uvus</cas:user>
                <cas:attributes>
                    <cas:edupersonaffiliation>member</cas:edupersonaffiliation>
                    <cas:edupersonaffiliation>student</cas:edupersonaffiliation>
                    <cas:givenname>Anne</cas:givenname><cas:givenname>Anne</cas:givenname>
                    <cas:mail>anne@example.org</cas:mail><cas:mail>anne@example.net</cas:mail>
                </cas:attributes>
            </cas:authenticationSuccess>
            """));
        assertEquals("uvus", profile.id());
        assertEquals("Anne", profile.firstName());
        assertNull(profile.email());
    }
    @Test void acceptsSimpleXmlTextButRejectsChildElementsInUser() throws Exception {
        var profile = UsCasIdentityProviderFactory.parseProfile(xml("""
            <cas:authenticationSuccess><cas:user>
                <![CDATA[uvus]]>
            </cas:user></cas:authenticationSuccess>
            """));
        assertEquals("uvus", profile.id());
        assertThrows(IllegalArgumentException.class, () -> UsCasIdentityProviderFactory.parseProfile(xml(
            "<cas:authenticationSuccess><cas:user><cas:uid>uvus</cas:uid></cas:user></cas:authenticationSuccess>")));
    }
    @Test void casRejectionReportsOnlyKnownCodes() {
        var known = assertThrows(UsCasIdentityProviderFactory.CasRejection.class,
            () -> UsCasIdentityProviderFactory.parseProfile(xml("<cas:authenticationFailure code='INVALID_SERVICE'>Private CAS detail</cas:authenticationFailure>")));
        assertEquals("INVALID_SERVICE", known.getMessage());
        var unknown = assertThrows(UsCasIdentityProviderFactory.CasRejection.class,
            () -> UsCasIdentityProviderFactory.parseProfile(xml("<cas:authenticationFailure code='provider-specific detail'/>")));
        assertEquals("UNKNOWN", unknown.getMessage());
    }
    @Test void rejectsFailuresMalformedOversizedAndAmbiguousResponses() {
        for (var body : new String[] {"<cas:authenticationFailure code='INVALID_TICKET'/>", "<cas:authenticationSuccess/>", "<cas:authenticationSuccess><cas:user>a</cas:user><cas:user>b</cas:user></cas:authenticationSuccess>", "<cas:authenticationSuccess><cas:user>a</cas:user></cas:authenticationSuccess><cas:authenticationFailure/>", "<authenticationSuccess><user>a</user></authenticationSuccess>"})
            assertThrows(Exception.class, () -> UsCasIdentityProviderFactory.parseProfile(xml(body)));
        assertThrows(Exception.class, () -> UsCasIdentityProviderFactory.parseProfile(new byte[65537]));
        assertThrows(Exception.class, () -> UsCasIdentityProviderFactory.parseProfile("<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><x>&e;</x>".getBytes(StandardCharsets.UTF_8)));
    }
    @Test void servicePreservesStateAndRequiresSafeTransport() {
        assertEquals("https://sphere.score.us.es/api/v1/users/auth/sso/us/callback?state=sti.a.b.c", UsCasIdentityProviderFactory.serviceUrl("https://sphere.score.us.es/api/v1/users/auth/sso/us/callback", "a.b.c"));
        assertThrows(Exception.class, () -> UsCasIdentityProviderFactory.serviceUrl("https://example.org/cb?state=evil", "x"));
        assertThrows(Exception.class, () -> UsCasIdentityProviderFactory.serviceUrl("http://example.org/cb", "x"));
        assertThrows(Exception.class, () -> UsCasIdentityProviderFactory.serviceUrl("https://example.org/cb", ""));
    }
    @Test void invalidCallbacksNeverValidateOrAuthenticate() {
        var config = new IdentityProviderModel();
        var provider = new UsCasIdentityProviderFactory.Provider(null, config);
        var callback = mock(UserAuthenticationIdentityProvider.AuthenticationCallback.class);
        var endpoint = (UsCasIdentityProviderFactory.Provider.Endpoint) provider.callback(null, callback, null);
        endpoint.get(null, "ST-ticket"); endpoint.get("foreign", "ST-ticket"); endpoint.get("sti.valid", "bad-ticket");
        verify(callback, times(3)).error(config, "identityProviderUnexpectedErrorMessage");
        verify(callback, never()).getAndVerifyAuthenticationSession(any());
        verify(callback, never()).authenticated(any());
    }
    @Test void staleOrWrongAuthenticationSessionIsRejectedBeforeNetwork() {
        var config = new IdentityProviderModel(); var provider = new UsCasIdentityProviderFactory.Provider(null, config);
        var callback = mock(UserAuthenticationIdentityProvider.AuthenticationCallback.class);
        var auth = mock(org.keycloak.sessions.AuthenticationSessionModel.class);
        when(callback.getAndVerifyAuthenticationSession("native")).thenReturn(auth);
        when(auth.getAuthNote(UsCasIdentityProviderFactory.STATE_NOTE)).thenReturn("different");
        var endpoint = (UsCasIdentityProviderFactory.Provider.Endpoint) provider.callback(null, callback, null);
        endpoint.get("sti.native", "ST-ticket");
        verify(callback).error(config, "identityProviderUnexpectedErrorMessage"); verify(callback, never()).authenticated(any());
    }
    @Test void validatesTicketAgainstExactStoredServiceAndConsumesTransaction() throws Exception {
        var server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        var queries = new java.util.ArrayList<String>();
        server.createContext("/CAS/serviceValidate", exchange -> {
            queries.add(exchange.getRequestURI().getRawQuery());
            byte[] body = xml("<cas:authenticationSuccess><cas:user>uvus</cas:user></cas:authenticationSuccess>");
            exchange.sendResponseHeaders(200, body.length); exchange.getResponseBody().write(body); exchange.close();
        });
        server.start();
        try {
            var config = new IdentityProviderModel(); config.setAlias("us-sso"); config.setEnabled(true);
            config.setConfig(new java.util.HashMap<>(java.util.Map.of("casUrl", "http://127.0.0.1:" + server.getAddress().getPort() + "/CAS")));
            var provider = new UsCasIdentityProviderFactory.Provider(null, config);
            var callback = mock(UserAuthenticationIdentityProvider.AuthenticationCallback.class);
            var auth = mock(org.keycloak.sessions.AuthenticationSessionModel.class);
            var notes = new java.util.HashMap<String, String>();
            String service = "https://sphere.score.us.es/api/v1/users/auth/sso/us/callback?state=sti.native";
            notes.put(UsCasIdentityProviderFactory.STATE_NOTE, "native"); notes.put(UsCasIdentityProviderFactory.SERVICE_NOTE, service);
            when(auth.getAuthNote(any())).thenAnswer(call -> notes.get(call.getArgument(0)));
            doAnswer(call -> { notes.remove(call.getArgument(0)); return null; }).when(auth).removeAuthNote(any());
            when(callback.getAndVerifyAuthenticationSession("native")).thenReturn(auth);
            var endpoint = (UsCasIdentityProviderFactory.Provider.Endpoint) provider.callback(null, callback, null);
            endpoint.get("sti.native", "ST-ticket"); endpoint.get("sti.native", "ST-ticket");
            assertEquals(1, queries.size());
            var parameters = java.util.Arrays.stream(queries.get(0).split("&"))
                .map(part -> part.split("=", 2)).collect(java.util.stream.Collectors.toMap(part -> part[0], part -> java.net.URLDecoder.decode(part[1], StandardCharsets.UTF_8)));
            assertEquals("ST-ticket", parameters.get("ticket")); assertEquals(service, parameters.get("service"));
            var identity = org.mockito.ArgumentCaptor.forClass(org.keycloak.broker.provider.BrokeredIdentityContext.class);
            verify(callback, times(1)).authenticated(identity.capture());
            assertEquals("uvus", identity.getValue().getId()); assertNull(identity.getValue().getEmail());
            assertSame(auth, identity.getValue().getAuthenticationSession());
            verify(callback, times(1)).error(config, "identityProviderUnexpectedErrorMessage");
        } finally { server.stop(0); }
    }
}
