package es.tentuplaza.identity.emailotp;

import jakarta.ws.rs.*;
import jakarta.ws.rs.core.*;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.keycloak.Config;
import org.keycloak.authentication.*;
import org.keycloak.forms.login.LoginFormsProvider;
import org.keycloak.models.*;
import org.keycloak.sessions.AuthenticationSessionModel;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.services.resource.*;
import org.keycloak.events.*;

/** Capability session: never calls AuthenticationManager, creates SSO or issues application tokens. */
public final class RecoveryResourceFactory implements RealmResourceProviderFactory {
  public String getId() { return "tentu-recovery"; }
  public RealmResourceProvider create(KeycloakSession session) {
    return new RealmResourceProvider() { public Object getResource() { return new Resource(session); } public void close() {} };
  }
  public void init(Config.Scope config) {}
  public void postInit(KeycloakSessionFactory factory) {}
  public void close() {}
  static boolean matches(String a,String b) { return a!=null && b!=null && MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8),b.getBytes(StandardCharsets.UTF_8)); }
  public static final class Resource {
    static final String COOKIE="tentu_recovery";
    final KeycloakSession session;
    final RecoveryStore store;
    Resource(KeycloakSession session) { this.session=session; store=new RecoveryStore(session); }
    private org.keycloak.services.managers.AuthenticationManager.AuthResult authorize(String permission, String userId) { return authorize(permission,userId,true); }
    private org.keycloak.services.managers.AuthenticationManager.AuthResult authorize(String permission, String userId, boolean recent) {
      var auth=new AppAuthManager.BearerTokenAuthenticator(session).setAudience("identity-admin-api").authenticate();
      SupportResourceFactory.requireAuthorization(store.realm,auth,permission,recent);
      Object scope=auth.getToken().getOtherClaims().get("tentu_step_up");
      // Support step-up is deliberately shared with credential management of the same user.
      if(recent && scope!=null && !scope.equals("user:"+userId+":credentials"))
        throw new ForbiddenException("This verification belongs to another account.");
      return auth;
    }
    @POST @Path("users/{userId}/prepare") @Produces(MediaType.APPLICATION_JSON)
    public Response prepare(@PathParam("userId") String userId) {
      var auth=authorize(RecoveryStore.CREATE,userId,false);
      return safe(Response.ok(store.prepare(auth.getUser(),userId)).build());
    }
    @POST @Path("users/{userId}") @Consumes(MediaType.APPLICATION_JSON) @Produces(MediaType.APPLICATION_JSON)
    public Response issue(@PathParam("userId") String userId, Map<String,Object> body) {
      var auth=authorize(RecoveryStore.CREATE,userId);
      if(body==null || !Boolean.TRUE.equals(body.get("identityVerified"))) throw new BadRequestException("Confirm identity verification.");
      var result=store.issue(auth.getUser(),userId,body.get("reason") instanceof String s ? s : null,body.get("draftId") instanceof String d ? d : null);
      return safe(Response.ok(result).build());
    }
    @GET @Path("users/{userId}") @Produces(MediaType.APPLICATION_JSON)
    public Response status(@PathParam("userId") String userId) {
      authorize("identity:users:recovery:view",userId,false);
      var values=store.em.createQuery("select r from RecoveryEntity r where r.realmId=:realm and r.userId=:user and r.state<>'draft' order by r.createdAt desc",RecoveryEntity.class)
          .setParameter("realm",store.realm.getId()).setParameter("user",userId).setMaxResults(1).getResultList();
      var body=new HashMap<String,Object>();
      if(values.isEmpty()) return safe(Response.ok("{\"recovery\":null}",MediaType.APPLICATION_JSON_TYPE).build());
      else { var value=values.getFirst(); String state=("issued".equals(value.state)||"claimed".equals(value.state)) && value.expiresAt<=RecoveryStore.now() ? "expired" : value.state;
        body.put("recovery",Map.of("id",value.id,"state",state,"expiresAt",value.expiresAt,"caseReference",value.caseReference)); }
      return safe(Response.ok(body).build());
    }
    @DELETE @Path("users/{userId}/{id}")
    public Response revoke(@PathParam("userId") String userId,@PathParam("id") String id) {
      var auth=authorize(RecoveryStore.REVOKE,userId);
      var value=store.get(id);
      if(!userId.equals(value.userId)) throw new NotFoundException();
      if(!"completed".equals(value.state)) { value.state="revoked"; store.event(value,"revoked",auth.getUser().getId()); }
      return safe(Response.noContent().build());
    }
    @GET @Produces(MediaType.TEXT_HTML)
    public Response landing() { return page("start",null,null); }
    @POST @Path("claim") @Consumes(MediaType.APPLICATION_FORM_URLENCODED) @Produces(MediaType.TEXT_HTML)
    public Response claim(@FormParam("token") String token) { return publicAction(() -> claimInternal(token)); }
    private Response claimInternal(String token) {
      origin();
      var value=store.bySecret(token,false); store.available(value,"issued");
      var target=session.users().getUserById(store.realm,value.userId);
      CredentialMutationLock.acquire(session,store.realm,target);
      var client=client();
      var root=session.authenticationSessions().createRootAuthenticationSession(store.realm);
      var auth=root.createAuthenticationSession(client); auth.setAuthenticatedUser(target); auth.setProtocol("openid-connect");
      value.rootId=root.getId(); value.tabId=auth.getTabId(); value.state="claimed";
      String browser=InvitationStore.token(); value.sessionHash=InvitationStore.hash(browser);
      store.event(value,"claimed");
      return safe(Response.fromResponse(page("choose",value,browser)).cookie(cookie(browser,600)).build());
    }
    @GET @Path("session") @Produces(MediaType.TEXT_HTML)
    public Response resume(@CookieParam(COOKIE) String browser) { return publicAction(() -> resumeInternal(browser)); }
    private Response resumeInternal(String browser) {
      var value=store.bySecret(browser,true); store.available(value,"claimed"); return page("choose",value,browser);
    }
    @GET @Path("method") @Produces(MediaType.TEXT_HTML)
    public Response challenge(@CookieParam(COOKIE) String browser) { return publicAction(() -> challengeInternal(browser)); }
    private Response challengeInternal(String browser) {
      var value=store.bySecret(browser,true); store.available(value,"claimed");
      if(value.method==null) return page("choose",value,browser);
      return nativeAction(value,browser,false);
    }
    @POST @Path("choose") @Consumes(MediaType.APPLICATION_FORM_URLENCODED) @Produces(MediaType.TEXT_HTML)
    public Response choose(@CookieParam(COOKIE) String browser,@FormParam("method") String method,@FormParam("csrf") String csrf) { return publicAction(() -> chooseInternal(browser,method,csrf)); }
    private Response chooseInternal(String browser,String method,String csrf) {
      origin(); var value=store.bySecret(browser,true); store.available(value,"claimed"); csrf(value,browser,csrf);
      if(!Set.of(AuthenticationPolicy.REGISTER,"CONFIGURE_TOTP").contains(method)) throw new BadRequestException();
      value.method=method; return safe(Response.seeOther(URI.create(base()+"/method")).build());
    }
    @POST @Path("method") @Consumes(MediaType.APPLICATION_FORM_URLENCODED) @Produces(MediaType.TEXT_HTML)
    public Response register(@CookieParam(COOKIE) String browser,@QueryParam("csrf") String csrf) { return publicAction(() -> registerInternal(browser,csrf)); }
    private Response registerInternal(String browser,String csrf) {
      origin(); var value=store.bySecret(browser,true); store.available(value,"claimed"); csrf(value,browser,csrf);
      if(value.method==null) throw new BadRequestException();
      CredentialMutationLock.acquire(session,store.realm,session.users().getUserById(store.realm,value.userId));
      try { return nativeAction(value,browser,true); }
      catch(RuntimeException error) { session.getTransactionManager().setRollbackOnly(); throw error; }
    }
    private Response publicAction(java.util.function.Supplier<Response> action) {
      try { return action.get(); }
      catch(WebApplicationException error) {
        return safe(Response.fromResponse(page("unavailable",null,null)).status(error.getResponse().getStatus()).build());
      }
    }
    private ClientModel client() {
      var client=store.realm.getClientByClientId("identity-account-web");
      if(client==null || !client.isEnabled() || !client.isPublicClient()) throw new ServiceUnavailableException("The account portal is unavailable.");
      return client;
    }
    private String base() { return session.getContext().getUri().getBaseUriBuilder().path("realms").path(store.realm.getName()).path("tentu-recovery").build().toString(); }
    private String csrfValue(RecoveryEntity value,String browser) { return InvitationStore.hash(browser+":"+value.id+":csrf"); }
    private void csrf(RecoveryEntity value,String browser,String supplied) { if(!matches(csrfValue(value,browser),supplied)) throw new ForbiddenException("Invalid request."); }
    private void origin() {
      URI uri=URI.create(base());
      String expected=uri.getScheme()+"://"+uri.getRawAuthority();
      if(!expected.equals(session.getContext().getRequestHeaders().getHeaderString("Origin"))) throw new ForbiddenException("Origin not allowed.");
    }
    private NewCookie cookie(String value,int seconds) {
      return new NewCookie.Builder(COOKIE).value(value).path(URI.create(base()).getPath()).httpOnly(true)
          .secure("https".equals(URI.create(base()).getScheme())).sameSite(NewCookie.SameSite.STRICT).maxAge(seconds).build();
    }
    private Response safe(Response response) {
      return Response.fromResponse(response).header("Cache-Control","no-store").header("Pragma","no-cache")
          // Preserve Origin on same-origin form POSTs; no-referrer makes browsers send Origin: null.
          // Cross-origin destinations receive neither Referer nor the fragment capability.
          .header("Referrer-Policy","same-origin").header("X-Frame-Options","DENY")
          .header("X-Content-Type-Options","nosniff").build();
    }
    private Response page(String phase,RecoveryEntity value,String browser) {
      var form=session.getProvider(LoginFormsProvider.class).setDetachedAuthSession()
          .setAttribute("recoveryMode",true).setAttribute("recoveryPhase",phase).setAttribute("recoveryBase",base())
          .setAttribute("recoveryCsrf",value==null ? "" : csrfValue(value,browser));
      var portal=store.realm.getClientByClientId("identity-account-web");
      if(portal!=null) {
        var origins=portal.getRedirectUris().stream().filter(url -> !url.contains("*") && url.endsWith("/auth/callback"))
            .map(url -> url.substring(0,url.length()-"/auth/callback".length())).collect(java.util.stream.Collectors.toSet());
        if(origins.size()==1) form.setAttribute("recoveryPortal",origins.iterator().next());
      }
      return safe(form.createForm("recovery.ftl"));
    }
    private Response nativeAction(RecoveryEntity value,String browser,boolean process) {
      var root=session.authenticationSessions().getRootAuthenticationSession(store.realm,value.rootId);
      var client=client(); var auth=root==null ? null : root.getAuthenticationSession(client,value.tabId);
      if(auth==null || !value.userId.equals(auth.getAuthenticatedUser().getId())) throw new ClientErrorException("This recovery session has expired. Request another link.",410);
      var user=session.users().getUserById(store.realm,value.userId);
      session.getContext().setClient(client); session.getContext().setAuthenticationSession(auth);
      URI action=URI.create(base()+"/method?csrf="+csrfValue(value,browser));
      var form=session.getProvider(LoginFormsProvider.class).setAuthenticationSession(auth).setUser(user).setActionUri(action)
          .setAttribute("recoveryMode",true);
      var event=new EventBuilder(store.realm,session,session.getContext().getConnection()).event(EventType.UPDATE_CREDENTIAL).user(user).client(client);
      Response[] response={null}; boolean[] success={false};
      var context=(RequiredActionContext)Proxy.newProxyInstance(RequiredActionContext.class.getClassLoader(),new Class<?>[]{RequiredActionContext.class},(proxy,method,args) -> {
        return switch(method.getName()) {
          case "getAction" -> value.method;
          case "getActionUrl" -> action;
          case "form" -> form;
          case "getChallenge" -> response[0];
          case "getEvent" -> event;
          case "getUser" -> user;
          case "getRealm" -> store.realm;
          case "getAuthenticationSession" -> auth;
          case "getConnection" -> session.getContext().getConnection();
          case "getUriInfo" -> session.getContext().getUri();
          case "getSession" -> session;
          case "getHttpRequest" -> session.getContext().getHttpRequest();
          case "getConfig", "getErrorMessage" -> null;
          case "generateCode" -> InvitationStore.token();
          case "getStatus" -> success[0] ? RequiredActionContext.Status.SUCCESS : RequiredActionContext.Status.CHALLENGE;
          case "challenge" -> { response[0]=(Response)args[0]; yield null; }
          case "success" -> { success[0]=true; yield null; }
          case "cancel", "failure", "ignore" -> { response[0]=page("choose",value,browser); yield null; }
          default -> throw new IllegalStateException("Unsupported recovery action context: "+method.getName());
        };
      });
      var factory=(RequiredActionFactory)session.getKeycloakSessionFactory().getProviderFactory(RequiredActionProvider.class,value.method);
      if(factory==null) throw new ServiceUnavailableException("Sign-in method unavailable.");
      var before=user.credentialManager().getStoredCredentialsStream().map(c -> c.getId()).collect(java.util.stream.Collectors.toSet());
      var provider=factory.create(session);
      try {
        if(process) {
          // Native registration must never invoke logout helpers requiring a normal user session.
          session.getContext().getHttpRequest().getDecodedFormParameters().remove("logout-sessions");
          provider.processAction(context);
        } else provider.requiredActionChallenge(context);
      } finally { provider.close(); }
      if(success[0]) {
        store.available(value,"claimed");
        if(user.credentialManager().getStoredCredentialsStream().noneMatch(c -> !before.contains(c.getId()) && ("otp".equals(c.getType()) || AuthenticationPolicy.PASSKEY.equals(c.getType()))))
          throw new ForbiddenException("No new sign-in method was registered.");
        store.notify(user,"completed");
        value.state="completed"; value.completedAt=RecoveryStore.now(); store.event(value,"completed");
        session.sessions().getUserSessionsStream(store.realm,user).toList().forEach(s -> session.sessions().removeUserSession(store.realm,s));
        session.authenticationSessions().removeRootAuthenticationSession(store.realm,root);
        return safe(Response.fromResponse(page("completed",null,null)).cookie(cookie("",0)).build());
      }
      if(process && ++value.attempts>=5) {
        value.state="revoked"; store.event(value,"attempts_exhausted");
        return safe(Response.fromResponse(page("blocked",null,null)).cookie(cookie("",0)).build());
      }
      if(response[0]==null) throw new ServiceUnavailableException("Unable to display the sign-in method.");
      return safe(response[0]);
    }
  }
}
