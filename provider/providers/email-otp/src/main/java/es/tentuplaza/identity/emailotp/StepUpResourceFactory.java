package es.tentuplaza.identity.emailotp;
import java.time.Instant;
import java.util.Map;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.*;
import org.keycloak.Config;
import org.keycloak.authentication.*;
import org.keycloak.models.*;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.services.resource.*;

/** A bearer-authenticated, short-lived ticket identifies the user; native factors verify possession. */
public final class StepUpResourceFactory implements RealmResourceProviderFactory {
  static final String NOTE="tentu.step-up.scope";
  public String getId() { return "tentu-step-up"; }
  public RealmResourceProvider create(KeycloakSession session) { return new RealmResourceProvider() {
    public Object getResource() { return new Resource(session); } public void close() { }
  }; }
  public void init(Config.Scope config) { } public void postInit(KeycloakSessionFactory factory) { } public void close() { }
  public static final class Resource {
    private final KeycloakSession session;
    Resource(KeycloakSession session) { this.session=session; }
    @POST @Consumes(MediaType.APPLICATION_JSON) @Produces(MediaType.APPLICATION_JSON)
    public Response begin(Map<String,Object> body) {
      var realm=session.getContext().getRealm();
      if(!"true".equals(realm.getAttribute("tentu.step-up.enabled"))) throw new ServiceUnavailableException("Identity verification is disabled.");
      if(body==null || !(body.get("scope") instanceof String scope) || !(scope.equals("self:security") || scope.matches("user:[a-f0-9-]{36}:(?:credentials|deactivate)"))) throw new BadRequestException("Invalid action.");
      boolean self=scope.equals("self:security");
      var auth=new AppAuthManager.BearerTokenAuthenticator(session).setAudience(self ? "identity-account-api" : "identity-admin-api").authenticate();
      authorizeScope(realm,auth,scope);
      if(!(body.get("origin") instanceof String origin) || !auth.getClient().getWebOrigins().contains(origin) || origin.contains("*") || !(origin.startsWith("https://") || origin.matches("http://(?:localhost|127\\.0\\.0\\.1):[0-9]+"))) throw new ForbiddenException("Origin not allowed.");
      if(!allowChallenge(session,realm.getId(),auth.getUser().getId())) throw new ClientErrorException("Wait before trying again.",429);
      String ticket=InvitationStore.token();
      session.singleUseObjects().put("tentu-step-up:"+InvitationStore.hash(ticket),180,Map.of("realm",realm.getId(),"user",auth.getUser().getId(),"session",auth.getSession().getId(),"client",auth.getClient().getClientId(),"origin",origin,"scope",scope));
      return Response.ok(Map.of("ticket",ticket,"expiresAt",Instant.now().plusSeconds(180).toEpochMilli())).header("Cache-Control","no-store").build();
    }
  }
  static void authorizeScope(RealmModel realm,org.keycloak.services.managers.AuthenticationManager.AuthResult auth,String scope) {
    if("self:security".equals(scope)) {
      if(auth==null || auth.getSession()==null || !auth.getUser().isEnabled() || !"identity-account-web".equals(auth.getToken().getIssuedFor())) throw new NotAuthorizedException("Bearer");
      return;
    }
    if(scope==null || !scope.matches("user:[a-f0-9-]{36}:(?:credentials|deactivate)")) throw new BadRequestException("Invalid action.");
    String permission=scope.endsWith(":deactivate") ? "identity:users:deactivate" : "identity:users:credentials:delete";
    SupportResourceFactory.requireAuthorization(realm,auth,permission,false);
  }
  // Allow one modal challenge plus one immediate popup replacement, across replicas.
  // Further requests remain throttled; tickets are still single-use and short-lived.
  static boolean allowChallenge(KeycloakSession session,String realmId,String userId) {
    String key="tentu-step-up-rate:"+realmId+":"+userId;
    for(int slot=0;slot<2;slot++) if(session.singleUseObjects().putIfAbsent(key+":"+slot,3)) return true;
    return false;
  }
  static boolean bind(AuthenticationFlowContext context) {
    var auth=context.getAuthenticationSession();
    String ticket=context.getUriInfo().getQueryParameters().getFirst("step_up_ticket");
    if(ticket==null || auth.getAuthNote(NOTE)!=null) return false;
    var data=context.getSession().singleUseObjects().remove("tentu-step-up:"+InvitationStore.hash(ticket));
    if(data==null || !context.getRealm().getId().equals(data.get("realm")) || !auth.getClient().getClientId().equals(data.get("client"))) throw new ForbiddenException("Identity verification has expired.");
    var callback=java.net.URI.create(auth.getRedirectUri());
    if(!(callback.getScheme()+"://"+callback.getRawAuthority()).equals(data.get("origin"))) throw new ForbiddenException("Callback no permitido.");
    var existing=context.getSession().sessions().getUserSession(context.getRealm(),data.get("session"));
    var user=context.getSession().users().getUserById(context.getRealm(),data.get("user"));
    if(existing==null || user==null || !user.isEnabled() || !existing.getUser().getId().equals(user.getId())) throw new NotAuthorizedException("Your session has expired.");
    auth.setAuthNote(NOTE,data.get("scope")); auth.setAuthNote("tentu.step-up.origin",data.get("origin"));
    auth.setAuthNote("tentu.step-up.user",user.getId()); auth.setAuthNote("tentu.step-up.session",existing.getId()); auth.setAuthNote("tentu.step-up.expires",Long.toString(Instant.now().plusSeconds(180).toEpochMilli()));
    context.setUser(user);
    var wrapped=frame(context);
    EmailOtpAuthenticator.INSTANCE.beginVerification(wrapped);
    return true;
  }
  static void complete(AuthenticationFlowContext context,String method) {
    var auth=context.getAuthenticationSession();
    if(auth.getAuthNote(NOTE)==null) return;
    var existing=context.getSession().sessions().getUserSession(context.getRealm(),auth.getAuthNote("tentu.step-up.session"));
    if(existing==null || !context.getUser().getId().equals(auth.getAuthNote("tentu.step-up.user")) || Long.parseLong(auth.getAuthNote("tentu.step-up.expires"))<=Instant.now().toEpochMilli()) throw new ForbiddenException("Identity verification has expired.");
    if(auth.getAuthNote(NOTE).startsWith("user:") && !AuthenticationPolicy.PASSKEY.equals(method)) throw new ForbiddenException("A passkey is required for this action.");
    auth.setUserSessionNote(NOTE,auth.getAuthNote(NOTE));
  }
  static AuthenticationFlowContext frame(AuthenticationFlowContext context) {
    var origin=context.getAuthenticationSession().getAuthNote("tentu.step-up.origin");
    if(origin==null) return context;
    // Final OIDC redirects have no challenge response to wrap. Native options prevent
    // the default SAMEORIGIN header from blocking their navigation out to the callback.
    context.getSession().getProvider(org.keycloak.headers.SecurityHeadersProvider.class).options().allowAnyFrameAncestor();
    return AuthenticationPolicy.observe(AuthenticationFlowContext.class,context,(name,args)->{
      if((name.equals("challenge") || name.equals("failureChallenge")) && args!=null) {
        int index=name.equals("challenge")?0:1;
        if(args[index] instanceof Response response) {
          // Keycloak normally overwrites response headers. Scope this exception to this response,
          // preserve every configured/default header, and permit only the ticket-bound origin.
          context.getSession().getProvider(org.keycloak.headers.SecurityHeadersProvider.class).options().skipHeaders();
          var builder=Response.fromResponse(response);
          var configured=context.getRealm().getBrowserSecurityHeaders();
          for(var header:BrowserSecurityHeaders.values()) {
            String value=configured.getOrDefault(header.getKey(),header.getDefaultValue());
            if(value!=null && !value.isEmpty()) builder.header(header.getHeaderName(),value);
          }
          String policy=configured.getOrDefault("contentSecurityPolicy",BrowserSecurityHeaders.CONTENT_SECURITY_POLICY.getDefaultValue());
          policy=policy.replaceAll("frame-ancestors[^;]*(;|$)","")+"; frame-ancestors 'self' "+origin+";";
          args[index]=builder.header("X-Frame-Options",null).header("Content-Security-Policy",null).header("Content-Security-Policy",policy).build();
        }
      }
    });
  }
}
