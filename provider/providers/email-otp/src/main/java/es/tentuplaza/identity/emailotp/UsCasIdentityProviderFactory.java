package es.tentuplaza.identity.emailotp;

import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.core.UriBuilder;
import org.jboss.logging.Logger;
import org.keycloak.broker.provider.*;
import org.keycloak.events.EventBuilder;
import org.keycloak.models.*;
import org.keycloak.sessions.AuthenticationSessionModel;
import org.w3c.dom.Element;

/** US CAS identity broker. External callback URLs are for an exact reverse-proxy route. */
public final class UsCasIdentityProviderFactory extends AbstractIdentityProviderFactory<UsCasIdentityProviderFactory.Provider> {
    public static final String ID = "score-us-cas";
    static final String STATE_PREFIX = "sti.";
    static final String STATE_NOTE = "score.cas.state";
    static final String SERVICE_NOTE = "score.cas.service";
    static final int MAX_RESPONSE = 65536;
    private static final Logger LOG = Logger.getLogger(UsCasIdentityProviderFactory.class);
    private static final String CAS_NS = "http://www.yale.edu/tp/cas";
    private static final HttpClient HTTP = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();

    /** Cancel the network stream before accumulating an oversized response. */
    private static final class LimitedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final HttpResponse.BodySubscriber<byte[]> body = HttpResponse.BodySubscribers.ofByteArray();
        private Flow.Subscription subscription;
        private long received;
        public CompletionStage<byte[]> getBody() { return body.getBody(); }
        public void onSubscribe(Flow.Subscription value) { subscription = value; body.onSubscribe(value); }
        public void onNext(List<ByteBuffer> buffers) {
            for (var buffer : buffers) received += buffer.remaining();
            if (received > MAX_RESPONSE) {
                subscription.cancel(); body.onError(new IllegalArgumentException("CAS response too large"));
            } else body.onNext(buffers);
        }
        public void onError(Throwable error) { body.onError(error); }
        public void onComplete() { body.onComplete(); }
    }

    @Override public String getId() { return ID; }
    @Override public String getName() { return "Universidad de Sevilla (CAS)"; }
    @Override public Provider create(KeycloakSession session, IdentityProviderModel model) { return new Provider(session, model); }
    @Override public IdentityProviderModel createConfig() { return new IdentityProviderModel(); }

    static URI checkedUrl(String value) {
        var uri = URI.create(value);
        boolean local = "http".equals(uri.getScheme()) && ("localhost".equals(uri.getHost()) || "127.0.0.1".equals(uri.getHost()));
        if ((!"https".equals(uri.getScheme()) && !local) || uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null || uri.getQuery() != null)
            throw new IllegalArgumentException("CAS URLs require HTTPS without credentials, query or fragment (HTTP allowed only on loopback).");
        return uri;
    }

    static String serviceUrl(String callback, String state) {
        if (state == null || state.isBlank() || state.length() > 8192) throw new IllegalArgumentException("Missing CAS state");
        return UriBuilder.fromUri(checkedUrl(callback)).queryParam("state", STATE_PREFIX + state).build().toString();
    }

    record Profile(String id, String email, String firstName, String lastName) {}

    static final class CasRejection extends IllegalArgumentException {
        CasRejection(String code) {
            super(switch (code) {
                case "INVALID_REQUEST", "INVALID_TICKET_SPEC", "UNAUTHORIZED_SERVICE",
                    "INVALID_TICKET", "INVALID_SERVICE", "INTERNAL_ERROR" -> code;
                default -> "UNKNOWN";
            });
        }
    }

    static Profile parseProfile(byte[] xml) throws Exception {
        if (xml.length == 0 || xml.length > MAX_RESPONSE) throw new IllegalArgumentException("Invalid CAS response size");
        var factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);
        var builder = factory.newDocumentBuilder();
        builder.setErrorHandler(new org.xml.sax.helpers.DefaultHandler() {
            @Override public void error(org.xml.sax.SAXParseException e) throws org.xml.sax.SAXException { throw e; }
            @Override public void fatalError(org.xml.sax.SAXParseException e) throws org.xml.sax.SAXException { throw e; }
        });
        var doc = builder.parse(new ByteArrayInputStream(xml));
        var root = doc.getDocumentElement();
        if (!CAS_NS.equals(root.getNamespaceURI()) || !"serviceResponse".equals(root.getLocalName())) throw new IllegalArgumentException("Invalid CAS envelope");
        Element result = null;
        for (var child = root.getFirstChild(); child != null; child = child.getNextSibling()) {
            if (!(child instanceof Element element)) continue;
            if (!CAS_NS.equals(element.getNamespaceURI()) || result != null)
                throw new IllegalArgumentException("Ambiguous CAS response");
            result = element;
        }
        if (result == null) throw new IllegalArgumentException("Missing CAS result");
        if ("authenticationFailure".equals(result.getLocalName())) throw new CasRejection(result.getAttribute("code"));
        if (!"authenticationSuccess".equals(result.getLocalName())) throw new IllegalArgumentException("Invalid CAS result");
        String id = null; Element attributes = null;
        for (var child = result.getFirstChild(); child != null; child = child.getNextSibling()) {
            if (!(child instanceof Element element) || !CAS_NS.equals(element.getNamespaceURI())) continue;
            if ("user".equals(element.getLocalName())) {
                if (id != null || element.getChildNodes().getLength() != 1) throw new IllegalArgumentException("Ambiguous CAS identity");
                id = element.getTextContent().trim();
            } else if ("attributes".equals(element.getLocalName())) {
                if (attributes != null) throw new IllegalArgumentException("Ambiguous CAS attributes");
                attributes = element;
            }
        }
        if (id == null || !id.matches("[A-Za-z0-9._@-]{1,200}")) throw new IllegalArgumentException("Invalid CAS identity");
        String first = attribute(attributes, "givenname");
        String last = String.join(" ", attribute(attributes, "schacsn1"), attribute(attributes, "schacsn2")).trim();
        if (last.isEmpty()) last = attribute(attributes, "sn");
        String email = attribute(attributes, "mail");
        if (!email.isEmpty() && !email.matches("[^\\s@]+@[^\\s@]+\\.[^\\s@]+")) email = "";
        return new Profile(id, email.isEmpty() ? null : email, first.isEmpty() ? null : first, last.isEmpty() ? null : last);
    }
    private static String attribute(Element attributes, String name) {
        if (attributes == null) return "";
        String result = "";
        for (var child = attributes.getFirstChild(); child != null; child = child.getNextSibling()) {
            if (child instanceof Element element && CAS_NS.equals(element.getNamespaceURI()) && name.equalsIgnoreCase(element.getLocalName())) {
                if (!result.isEmpty()) throw new IllegalArgumentException("Ambiguous CAS attribute");
                result = element.getTextContent().trim();
                if (result.length() > 1024) throw new IllegalArgumentException("Oversized CAS attribute");
            }
        }
        return result;
    }

    public static final class Provider extends AbstractIdentityProvider<IdentityProviderModel> {
        Provider(KeycloakSession session, IdentityProviderModel config) { super(session, config); }
        @Override public Response retrieveToken(KeycloakSession session, FederatedIdentityModel identity) {
            return Response.status(Response.Status.BAD_REQUEST).build();
        }
        @Override public Response retrieveToken(KeycloakSession session, FederatedIdentityModel identity, UserSessionModel userSession, UserModel user) {
            return Response.status(Response.Status.BAD_REQUEST).build(); // CAS tickets are never retained/exchanged.
        }
        private String casUrl() { return checkedUrl(getConfig().getConfig().getOrDefault("casUrl", "https://sso.us.es/CAS")).toString().replaceAll("/+$", ""); }
        @Override public Response performLogin(AuthenticationRequest request) {
            var state = request.getState().getEncoded();
            var service = serviceUrl(getConfig().getConfig().getOrDefault("callbackUrl", request.getRedirectUri()), state);
            request.getAuthenticationSession().setAuthNote(STATE_NOTE, state);
            request.getAuthenticationSession().setAuthNote(SERVICE_NOTE, service);
            return Response.seeOther(UriBuilder.fromUri(casUrl() + "/login").queryParam("service", service).build()).build();
        }
        @Override public Object callback(RealmModel realm, UserAuthenticationIdentityProvider.AuthenticationCallback callback, EventBuilder event) { return new Endpoint(this, callback); }
        public static final class Endpoint {
            private final UserAuthenticationIdentityProvider.AuthenticationCallback callback;
            private final Provider provider;
            Endpoint(Provider provider, UserAuthenticationIdentityProvider.AuthenticationCallback callback) { this.provider = provider; this.callback = callback; }
            @GET public Response get(@QueryParam("state") String state, @QueryParam("ticket") String ticket) {
                String stage = "callback";
                try {
                    if (state == null || !state.startsWith(STATE_PREFIX) || state.length() > 8200)
                        return failure(stage, "invalid_state");
                    if (ticket == null || !ticket.matches("ST-[A-Za-z0-9._-]{1,2048}"))
                        return failure(stage, ticket == null ? "missing_ticket" : "invalid_ticket_format");
                    stage = "session";
                    String nativeState = state.substring(STATE_PREFIX.length());
                    AuthenticationSessionModel auth = callback.getAndVerifyAuthenticationSession(nativeState);
                    if (auth == null) return failure(stage, "missing_session");
                    if (!nativeState.equals(auth.getAuthNote(STATE_NOTE))) return failure(stage, "state_mismatch");
                    String service = auth.getAuthNote(SERVICE_NOTE);
                    auth.removeAuthNote(STATE_NOTE); auth.removeAuthNote(SERVICE_NOTE);
                    if (service == null) return failure(stage, "missing_service");
                    stage = "validation_request";
                    var validation = UriBuilder.fromUri(provider.casUrl() + "/serviceValidate").queryParam("ticket", ticket).queryParam("service", service).build();
                    var request = HttpRequest.newBuilder(validation).timeout(Duration.ofSeconds(10)).header("Accept", "application/xml").GET().build();
                    var pending = HTTP.sendAsync(request, ignored -> new LimitedBody());
                    HttpResponse<byte[]> response;
                    try { response = pending.get(10, TimeUnit.SECONDS); }
                    finally { if (!pending.isDone()) pending.cancel(true); }
                    if (response.statusCode() != 200) return failure(stage, "HTTP_" + response.statusCode());
                    stage = "validation_response";
                    Profile profile = parseProfile(response.body());
                    stage = "keycloak_broker";
                    var identity = new BrokeredIdentityContext(profile.id(), provider.getConfig());
                    identity.setIdp(provider); identity.setAuthenticationSession(auth);
                    identity.setUsername(profile.id()); identity.setEmail(profile.email());
                    identity.setFirstName(profile.firstName()); identity.setLastName(profile.lastName());
                    identity.setBrokerUserId(provider.getConfig().getAlias() + "." + profile.id());
                    return callback.authenticated(identity);
                } catch (CasRejection rejection) {
                    return failure("cas_rejected", rejection.getMessage());
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    return failure(stage, "interrupted");
                } catch (Exception error) {
                    Throwable cause = error instanceof ExecutionException && error.getCause() != null ? error.getCause() : error;
                    return failure(stage, cause.getClass().getSimpleName());
                }
            }

            private Response failure(String stage, String reason) {
                // Record only fixed labels, HTTP status, standard CAS codes or exception types.
                LOG.warnf("US CAS sign-in failed: stage=%s reason=%s", stage, reason);
                return callback.error(provider.getConfig(), "identityProviderUnexpectedErrorMessage");
            }
        }
        @Override public void importNewUser(KeycloakSession session, RealmModel realm, UserModel user, BrokeredIdentityContext identity) {
            user.setEmailVerified(false);
        }
    }
}
