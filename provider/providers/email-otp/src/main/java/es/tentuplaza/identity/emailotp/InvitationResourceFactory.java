package es.tentuplaza.identity.emailotp;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.*;
import java.net.URI;
import java.time.Instant;
import java.util.*;
import org.keycloak.Config;
import org.keycloak.models.*;
import org.keycloak.representations.AccessToken;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.services.managers.AuthenticationManager.AuthResult;
import org.keycloak.services.resource.*;
import org.keycloak.events.*;

public final class InvitationResourceFactory implements RealmResourceProviderFactory {
  public String getId() { return "tentu-invitations"; }
  public RealmResourceProvider create(KeycloakSession session) { return new RealmResourceProvider() {
    public Object getResource() { return new Resource(session); } public void close() { }
  }; }
  public void init(Config.Scope config) { } public void postInit(KeycloakSessionFactory factory) { } public void close() { }
  // Development callbacks can coexist with the deployed portal in the client.
  // Never choose a destination by lexical order or send deployed invitations to loopback.
  static String portalCallback(ClientModel client,URI provider) {
    boolean local=loopback(provider.getHost());
    var callbacks=client.getRedirectUris().stream().filter(value -> {
      try {
        var uri=URI.create(value);
        return !value.contains("*") && uri.isAbsolute() && uri.getHost()!=null
          && uri.getUserInfo()==null && uri.getRawQuery()==null && uri.getRawFragment()==null
          && "/auth/callback".equals(uri.getRawPath())
          && (local ? loopback(uri.getHost()) && ("http".equals(uri.getScheme()) || "https".equals(uri.getScheme()))
                    : !loopback(uri.getHost()) && "https".equals(uri.getScheme()));
      } catch(IllegalArgumentException invalid) { return false; }
    }).toList();
    if(callbacks.size()!=1) throw new ServiceUnavailableException("Configure one registration callback for this environment.");
    return callbacks.getFirst();
  }
  private static boolean loopback(String host) {
    return host!=null && (host.equalsIgnoreCase("localhost") || host.equals("127.0.0.1") || host.equals("::1") || host.equals("[::1]"));
  }
  static Map<String,Object> invitationUser(InvitationRedemptionEntity redemption, UserModel user) {
    var data=new LinkedHashMap<String,Object>();
    data.put("id",redemption.userId);
    data.put("email",user==null ? null : user.getEmail());
    data.put("registeredAt",redemption.completedAt);
    data.put("roles",List.of(redemption.roleNames.split("\n")));
    data.put("catalogueRevision",redemption.catalogueRevision);
    return data;
  }
  /** Store.delegable still checks live grants; this adds the signed delegation boundary. */
  static void assertSignedDelegation(RealmModel realm, UserModel actor, AccessToken token, List<String> names) {
    var access=token==null ? null : token.getRealmAccess();
    if(access==null || !access.isUserInRole("identity:users:update:roles"))
      throw new ForbiddenException("Role assignment permission is required.");
    if(actor==null || !actor.isEnabled()) throw new ForbiddenException("A current enabled user is required.");
    if(names==null || names.isEmpty() || names.size()>50 || new HashSet<>(names).size()!=names.size())
      throw new BadRequestException("Select between one and fifty distinct roles.");
    var registry=AuthorizationResourceFactory.read(realm);
    if(registry==null || registry.roles==null || registry.permissions==null)
      throw new ServiceUnavailableException("The applied catalogue is unavailable.");
    var definitions=new HashMap<String,AuthorizationResourceFactory.Role>();
    var atoms=new HashSet<String>();
    for(var permission:registry.permissions) {
      if(permission==null || permission.name==null || !atoms.add(permission.name))
        throw new ClientErrorException("The applied permission catalogue is invalid.",409);
    }
    for(var role:registry.roles) {
      if(role==null || role.name==null || role.permissions==null || atoms.contains(role.name)
          || definitions.putIfAbsent(role.name,role)!=null)
        throw new ClientErrorException("The applied role catalogue is invalid.",409);
    }
    var leaves=new HashSet<String>();
    for(String name:names) {
      if(!definitions.containsKey(name)) throw new ClientErrorException("An invitation role is no longer available.",409);
      collectSignedLeaves(realm,name,definitions,atoms,leaves,new HashSet<>(),new HashSet<>());
    }
    var administrator=realm.getRole("administrador");
    if(administrator!=null && actor.hasRole(administrator)) return;
    if(leaves.stream().anyMatch(permission -> !access.isUserInRole(permission)))
      throw new ForbiddenException("Your token cannot delegate these roles.");
  }
  private static void collectSignedLeaves(RealmModel realm,String name,
      Map<String,AuthorizationResourceFactory.Role> definitions,Set<String> atoms,Set<String> leaves,
      Set<String> visiting,Set<String> visited) {
    if(visited.contains(name)) return;
    if(!visiting.add(name)) throw new ClientErrorException("The applied role graph contains a cycle.",409);
    var live=realm.getRole(name);
    if(live==null || live.isClientRole() || !name.equals(live.getName()))
      throw new ClientErrorException("An invitation role or permission is no longer available.",409);
    var definition=definitions.get(name);
    if(definition==null) {
      if(!atoms.contains(name) || live.isComposite())
        throw new ClientErrorException("Permission is not an active atomic catalogue permission.",409);
      leaves.add(name);
    } else {
      var expected=new HashSet<>(definition.permissions);
      if(expected.size()!=definition.permissions.size() || expected.contains(null)
          || (!"administrador".equals(name) && expected.contains("administrador")))
        throw new ClientErrorException("The applied role references are invalid.",409);
      var children=live.getCompositesStream().toList();
      if(children.size()!=expected.size() || children.stream().anyMatch(child -> child==null || child.isClientRole()
          || !expected.contains(child.getName())) || !children.stream().map(RoleModel::getName)
              .collect(java.util.stream.Collectors.toSet()).equals(expected))
        throw new ClientErrorException("The applied role does not match the catalogue.",409);
      for(String child:expected) collectSignedLeaves(realm,child,definitions,atoms,leaves,visiting,visited);
    }
    visiting.remove(name); visited.add(name);
  }
  public static final class Resource {
    private final KeycloakSession session; private final RealmModel realm; private final InvitationStore store;
    Resource(KeycloakSession session) { this.session=session; realm=session.getContext().getRealm(); store=new InvitationStore(session); }
    AuthResult authorize(String permission) {
      var auth=new AppAuthManager.BearerTokenAuthenticator(session).setAudience("identity-admin-api").authenticate();
      SupportResourceFactory.requireAuthorization(realm,auth,permission,false); return auth;
    }
    private void audit(AuthResult auth,String action,String target) {
      new EventBuilder(realm,session,session.getContext().getConnection()).event(EventType.CUSTOM_REQUIRED_ACTION).user(auth.getUser()).session(auth.getSession()).client(auth.getClient()).detail("tentu_action",action).detail("invitation_id",target).success();
    }
    @POST @Consumes(MediaType.APPLICATION_JSON) @Produces(MediaType.APPLICATION_JSON)
    public Response create(Map<String,Object> body) {
      store.enabled(); var auth=authorize("identity:invitations:create");
      AuthorizationResourceFactory.acquire(session,realm);
      var name=name(body.get("name")); var limit=limit(body.get("limit"));
      if(!(body.get("roles") instanceof List<?> items) || items.isEmpty() || items.size()>50 || items.stream().anyMatch(x -> !(x instanceof String))) throw new BadRequestException("Select between one and fifty roles.");
      var names=items.stream().map(String.class::cast).distinct().sorted().toList();
      store.delegable(auth.getUser(),names);
      assertSignedDelegation(realm,auth.getUser(),auth.getToken(),names);
      if(names.contains("administrador")) SupportResourceFactory.requireAuthorization(realm,auth,"identity:invitations:create",true);
      var invitation=new InvitationEntity(); var token=InvitationStore.token();
      invitation.id=UUID.randomUUID().toString(); invitation.realmId=realm.getId(); invitation.environment=environment(); invitation.name=name; invitation.tokenHash=InvitationStore.hash(token); invitation.roleNames=String.join("\n",names); invitation.roleFingerprint=store.fingerprint(names); invitation.catalogueRevision=AuthorizationResourceFactory.read(realm).revision; invitation.capacity=limit; invitation.creator=auth.getUser().getId(); invitation.createdAt=Instant.now().toEpochMilli(); invitation.expiresAt=expires(body.get("expiresAt")); store.persist(invitation);
      audit(auth,"invitation.create",invitation.id);
      return Response.status(201).entity(Map.of("invitation",store.view(invitation),"link",issuer()+"/tentu-invitations/join#"+token)).header("Cache-Control","no-store").build();
    }
    String issuer() { return session.getContext().getUri().getBaseUri().toString().replaceAll("/$","")+"/realms/"+realm.getName(); }
    String environment() { var registry=AuthorizationResourceFactory.read(realm); if(registry==null) throw new ServiceUnavailableException("The applied catalogue is unavailable."); return registry.environment; }
    static String name(Object value) { if(!(value instanceof String s) || s.trim().isEmpty() || s.trim().length()>150) throw new BadRequestException("Invalid name."); return s.trim(); }
    static int limit(Object value) { if(!(value instanceof Number n) || n.doubleValue()!=n.intValue() || n.intValue()<1 || n.intValue()>100000) throw new BadRequestException("Invalid limit."); return n.intValue(); }
    static Long expires(Object value) { if(value==null) return null; if(!(value instanceof Number n) || n.doubleValue()!=n.longValue() || n.longValue()<=Instant.now().toEpochMilli()) throw new BadRequestException("Invalid expiry."); return n.longValue(); }
    @GET @Produces(MediaType.APPLICATION_JSON)
    public Response list(@QueryParam("first") @DefaultValue("0") int first,@QueryParam("max") @DefaultValue("25") int max,@QueryParam("state") String state,@QueryParam("search") String search) {
      authorize("identity:invitations:view"); page(first,max);
      if(state!=null && !Set.of("active","expired","revoked","exhausted","blocked").contains(state)) throw new BadRequestException("Invalid state.");
      if(search!=null && search.length()>150) throw new BadRequestException("Invalid search.");
      String query=search==null ? "" : search.trim().toLowerCase(Locale.ROOT);
      var result=new ArrayList<Map<String,Object>>(); int offset=0, matched=0;
      while(result.size()<max) { var values=store.list(offset,100); if(values.isEmpty()) break; offset+=values.size();
        for(var invitation:values) if((state==null || state.equals(store.state(invitation))) && matches(invitation,query)) { if(matched++>=first && result.size()<max) result.add(store.view(invitation)); }
        if(values.size()<100) break;
      }
      return Response.ok(Map.of("invitations",result)).header("Cache-Control","no-store").build();
    }
    static boolean matches(InvitationEntity invitation,String query) {
      return query.isEmpty() || invitation.name.toLowerCase(Locale.ROOT).contains(query)
          || invitation.roleNames.toLowerCase(Locale.ROOT).contains(query);
    }
    static void page(int first,int max) { if(first<0 || first>10000 || max<1 || max>100) throw new BadRequestException("Invalid page."); }
    @GET @Path("{id}") @Produces(MediaType.APPLICATION_JSON)
    public Response detail(@PathParam("id") String id) { authorize("identity:invitations:view"); return Response.ok(store.view(store.get(id,false))).header("Cache-Control","no-store").build(); }
    @PATCH @Path("{id}") @Consumes(MediaType.APPLICATION_JSON) @Produces(MediaType.APPLICATION_JSON)
    public Response update(@PathParam("id") String id,Map<String,Object> body) {
      var auth=authorize("identity:invitations:update"); var invitation=store.get(id,true);
      if(body.containsKey("roles")) throw new BadRequestException("An invitation’s roles cannot be changed.");
      if(!(body.get("version") instanceof Number n) || n.longValue()!=invitation.version) throw new ClientErrorException("The invitation has changed. Refresh its details.",409);
      if(body.containsKey("limit")) { int capacity=limit(body.get("limit")); if(capacity<invitation.completed) throw new ClientErrorException("The limit cannot be lower than completed registrations.",409); invitation.capacity=capacity; }
      if(body.containsKey("name")) invitation.name=name(body.get("name"));
      if(body.containsKey("expiresAt")) invitation.expiresAt=expires(body.get("expiresAt"));
      session.getProvider(org.keycloak.connections.jpa.JpaConnectionProvider.class).getEntityManager().flush(); audit(auth,"invitation.update",id); return Response.ok(store.view(invitation)).header("Cache-Control","no-store").build();
    }
    @DELETE @Path("{id}")
    public Response delete(@PathParam("id") String id) {
      var auth=authorize("identity:invitations:delete");
      AuthorizationResourceFactory.acquire(session,realm);
      store.delete(id); audit(auth,"invitation.delete",id);
      return Response.noContent().header("Cache-Control","no-store").build();
    }
    @POST @Path("{id}/revoke") @Produces(MediaType.APPLICATION_JSON)
    public Response revoke(@PathParam("id") String id) { var auth=authorize("identity:invitations:revoke"); var invitation=store.get(id,true); if(invitation.revokedAt==null) invitation.revokedAt=Instant.now().toEpochMilli(); audit(auth,"invitation.revoke",id); return Response.ok(store.view(invitation)).header("Cache-Control","no-store").build(); }
    @GET @Path("{id}/users") @Produces(MediaType.APPLICATION_JSON)
    public Response users(@PathParam("id") String id,@QueryParam("first") @DefaultValue("0") int first,@QueryParam("max") @DefaultValue("25") int max) {
      authorize("identity:invitations:view"); page(first,max);
      var users=store.users(id,first,max).stream().map(r -> invitationUser(r,session.users().getUserById(realm,r.userId))).toList();
      return Response.ok(Map.of("users",users)).header("Cache-Control","no-store").build();
    }
    @GET @Path("join") @Produces(MediaType.TEXT_HTML)
    public Response join() {
      store.enabled();
      return Response.ok("""
        <!doctype html><html lang="es"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Invitation · SCORETech Identity</title>
        <body><p>Preparing your invitation…</p><form method="post" action="start"><input type="hidden" name="token"></form>
        <script>const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);if(/^[A-Za-z0-9_-]{43}$/.test(token)){document.querySelector('input').value=token;document.querySelector('form').submit()}else document.querySelector('p').textContent='Invalid invitation link.';</script></body></html>
        """).header("Cache-Control","no-store").header("Referrer-Policy","no-referrer").build();
    }
    @POST @Path("start") @Consumes(MediaType.APPLICATION_FORM_URLENCODED)
    public Response start(@FormParam("token") String token) {
      var address=session.getContext().getConnection().getRemoteAddr();
      // Atomic distributed slots permit shared links behind NAT without an IP-wide cooldown.
      String bucket="tentu-invite-start:"+realm.getId()+":"+InvitationStore.hash(address)+":"+(Instant.now().getEpochSecond()/60);
      boolean accepted=false;
      for(int slot=0;slot<60;slot++) if(session.singleUseObjects().putIfAbsent(bucket+":"+slot,120)) { accepted=true; break; }
      if(!accepted) throw new ClientErrorException("Demasiados intentos. Espera un minuto.",429);
      final InvitationEntity invitation;
      try { invitation=store.byToken(token); }
      catch(NotFoundException error) { return session.getProvider(org.keycloak.forms.login.LoginFormsProvider.class).setError("tentuInvitationInvalid").createErrorPage(Response.Status.NOT_FOUND); }
      catch(ServiceUnavailableException error) { return session.getProvider(org.keycloak.forms.login.LoginFormsProvider.class).setError("tentuInvitationUnavailable").createErrorPage(Response.Status.SERVICE_UNAVAILABLE); }
      String state=store.state(invitation);
      if(!"active".equals(state)) return session.getProvider(org.keycloak.forms.login.LoginFormsProvider.class).setError("tentuInvitation"+switch(state) { case "exhausted" -> "Exhausted"; case "expired" -> "Expired"; case "revoked" -> "Revoked"; default -> "Unavailable"; }).createErrorPage(Response.Status.CONFLICT);
      var client=realm.getClientByClientId("identity-account-web");
      if(client==null || !client.isEnabled() || !client.isPublicClient()) throw new ServiceUnavailableException("Cliente de registro no disponible.");
      // The account portal starts its normal OIDC flow; no PKCE verifier is exposed by this endpoint.
      var target=portalCallback(client,session.getContext().getUri().getBaseUri());
      var ticket=InvitationStore.token(); session.singleUseObjects().put("tentu-invitation-ticket:"+InvitationStore.hash(ticket),600,Map.of("realm",realm.getId(),"invitation",invitation.id,"client",client.getClientId()));
      return Response.seeOther(URI.create(target.substring(0,target.length()-"/auth/callback".length())+"/invite#"+ticket)).header("Cache-Control","no-store").header("Referrer-Policy","no-referrer").build();
    }
  }
}
