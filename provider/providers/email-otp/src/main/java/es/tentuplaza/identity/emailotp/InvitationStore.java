package es.tentuplaza.identity.emailotp;
import jakarta.persistence.*;
import jakarta.ws.rs.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.time.Instant;
import java.util.*;
import org.keycloak.models.*;
import org.keycloak.connections.jpa.JpaConnectionProvider;
import org.keycloak.sessions.AuthenticationSessionModel;

final class InvitationStore {
  static final String NOTE = "tentu.invitation.id";
  static final String PROVISIONAL = "tentu.registration.provisional";
  private final KeycloakSession session;
  private final RealmModel realm;
  private final EntityManager em;
  InvitationStore(KeycloakSession session) {
    this.session=session; realm=session.getContext().getRealm();
    em=session.getProvider(JpaConnectionProvider.class).getEntityManager();
  }
  static String hash(String value) {
    try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
    catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
  }
  static String token() { byte[] bytes=new byte[32]; new SecureRandom().nextBytes(bytes); return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }
  void enabled() { if (!"true".equals(realm.getAttribute("tentu.invitations.enabled"))) throw new ServiceUnavailableException("Invitations are disabled."); }
  List<String> roles(InvitationEntity invitation) { return List.of(invitation.roleNames.split("\n")); }
  String fingerprint(List<String> names) {
    var registry=AuthorizationResourceFactory.read(realm);
    if (registry==null) throw new ServiceUnavailableException("The applied catalogue is unavailable.");
    var definitions=new TreeSet<String>(); var seen=new HashSet<String>();
    for (var name:names) collect(name, registry, definitions, seen);
    return hash(String.join("\n", definitions));
  }
  private void collect(String name, AuthorizationResourceFactory.Registry registry, Set<String> definitions, Set<String> seen) {
    if (!seen.add(name)) return;
    var role=registry.roles.stream().filter(r -> r.name.equals(name)).findFirst().orElse(null);
    var live=realm.getRole(name);
    if (role==null || live==null) throw new ClientErrorException("An invitation role is no longer available.",409);
    var children=new TreeSet<>(role.permissions);
    var liveChildren=live.getCompositesStream().map(RoleModel::getName).collect(java.util.stream.Collectors.toCollection(TreeSet::new));
    if(!liveChildren.equals(children)) throw new ClientErrorException("The applied role does not match the catalogue.",409);
    definitions.add(name+":"+live.getId()+":"+String.join(",",children));
    for(var child:children) {
      if(registry.roles.stream().anyMatch(r -> r.name.equals(child))) collect(child,registry,definitions,seen);
      else if(registry.permissions.stream().noneMatch(p -> p.name.equals(child))) throw new ClientErrorException("Permission is not in the applied catalogue.",409);
    }
  }
  void delegable(UserModel actor, List<String> names) {
    var permission=realm.getRole("identity:users:update:roles");
    if(actor==null || !actor.isEnabled() || permission==null || !actor.hasRole(permission)) throw new ForbiddenException("You cannot delegate roles.");
    var registry=AuthorizationResourceFactory.read(realm);
    if(registry==null) throw new ServiceUnavailableException("The applied catalogue is unavailable.");
    fingerprint(names);
    for(var name:names) {
      var role=realm.getRole(name);
      if("administrador".equals(name) && (realm.getRole("administrador")==null || !actor.hasRole(realm.getRole("administrador")))) throw new ForbiddenException("You cannot delegate the protected administrator role.");
      var leaves=new HashSet<RoleModel>(); collectLeaves(role,leaves,new HashSet<>());
      if(leaves.stream().filter(r -> registry.permissions.stream().anyMatch(p -> p.name.equals(r.getName()))).anyMatch(r -> !actor.hasRole(r))) throw new ForbiddenException("You cannot grant permissions you do not have.");
    }
  }
  private void collectLeaves(RoleModel role, Set<RoleModel> result, Set<String> seen) {
    if(!seen.add(role.getId())) return;
    if(role.isComposite()) role.getCompositesStream().forEach(r -> collectLeaves(r,result,seen)); else result.add(role);
  }
  InvitationEntity get(String id, boolean lock) {
    var value=lock ? em.find(InvitationEntity.class,id,LockModeType.PESSIMISTIC_WRITE) : em.find(InvitationEntity.class,id);
    if(value==null || !realm.getId().equals(value.realmId)) throw new NotFoundException();
    return value;
  }
  String state(InvitationEntity value) {
    if(value.revokedAt!=null) return "revoked";
    if(value.expiresAt!=null && value.expiresAt<=Instant.now().toEpochMilli()) return "expired";
    if(value.completed>=value.capacity) return "exhausted";
    try { if(!value.roleFingerprint.equals(fingerprint(roles(value)))) return "blocked";
      delegable(session.users().getUserById(realm,value.creator),roles(value));
      var creator=session.users().getUserById(realm,value.creator); var permission=realm.getRole("identity:invitations:create");
      if(permission==null || !creator.hasRole(permission)) return "blocked";
    } catch(ClientErrorException error) { return "blocked"; }
    return "active";
  }
  void available(InvitationEntity invitation) { enabled(); if(!"active".equals(state(invitation))) throw new ClientErrorException("Invitation unavailable: "+state(invitation),409); }
  InvitationEntity byToken(String token) {
    enabled(); if(token==null || !token.matches("[A-Za-z0-9_-]{43}")) throw new NotFoundException();
    var values=em.createQuery("select i from InvitationEntity i where i.realmId=:realm and i.tokenHash=:hash",InvitationEntity.class).setParameter("realm",realm.getId()).setParameter("hash",hash(token)).getResultList();
    if(values.isEmpty()) throw new NotFoundException(); return values.getFirst();
  }
  Map<String,Object> view(InvitationEntity value) {
    var data=new LinkedHashMap<String,Object>(); String status=state(value);
    data.put("id",value.id); data.put("environment",value.environment); data.put("name",value.name);
    data.put("roles",roles(value)); data.put("limit",value.capacity); data.put("completed",value.completed); data.put("available","active".equals(status) ? Math.max(0,value.capacity-value.completed) : 0);
    data.put("creator",value.creator); data.put("createdAt",value.createdAt); data.put("expiresAt",value.expiresAt); data.put("revokedAt",value.revokedAt); data.put("state",status); data.put("version",value.version);
    return data;
  }
  List<InvitationEntity> list(int first,int max) { return em.createQuery("select i from InvitationEntity i where i.realmId=:realm order by i.createdAt desc,i.id",InvitationEntity.class).setParameter("realm",realm.getId()).setFirstResult(first).setMaxResults(max).getResultList(); }
  List<InvitationRedemptionEntity> users(String id,int first,int max) { get(id,false); return em.createQuery("select r from InvitationRedemptionEntity r where r.invitationId=:id order by r.completedAt desc,r.id",InvitationRedemptionEntity.class).setParameter("id",id).setFirstResult(first).setMaxResults(max).getResultList(); }
  void delete(String id) {
    // Serialize against redemption. Keep redemption evidence and already granted roles.
    var invitation=get(id,true);
    if(invitation.revokedAt==null && (invitation.expiresAt==null || invitation.expiresAt>Instant.now().toEpochMilli()))
      throw new ClientErrorException("Only revoked or expired invitations can be deleted.",409);
    em.remove(invitation);
    em.flush();
  }
  void persist(InvitationEntity value) { em.persist(value); em.flush(); }
  void redeem(AuthenticationSessionModel auth, UserModel user) {
    String id=auth.getAuthNote(NOTE); if(id==null) return;
    enabled();
    AuthorizationResourceFactory.acquire(session,realm);
    var invitation=get(id,true);
    var previous=em.createQuery("select r from InvitationRedemptionEntity r where r.realmId=:realm and r.userId=:user",InvitationRedemptionEntity.class).setParameter("realm",realm.getId()).setParameter("user",user.getId()).getResultList();
    if(!previous.isEmpty()) { if(previous.getFirst().invitationId.equals(id)) return; throw new ClientErrorException("This account has already completed registration.",409); }
    if(!"true".equals(user.getFirstAttribute(PROVISIONAL))) throw new ForbiddenException("Existing accounts cannot redeem new-member invitations.");
    available(invitation);
    var registry=AuthorizationResourceFactory.read(realm);
    for(var name:roles(invitation)) user.grantRole(realm.getRole(name));
    var redemption=new InvitationRedemptionEntity(); redemption.id=UUID.randomUUID().toString(); redemption.invitationId=id; redemption.realmId=realm.getId(); redemption.userId=user.getId(); redemption.completedAt=Instant.now().toEpochMilli(); redemption.roleNames=invitation.roleNames; redemption.catalogueRevision=registry.revision;
    em.persist(redemption); invitation.completed++; user.removeAttribute(PROVISIONAL); user.setSingleAttribute("tentuRegistrationCompletedAt",Instant.now().toString()); em.flush();
  }
}
