package es.tentuplaza.identity.emailotp;

import jakarta.persistence.*;
import jakarta.ws.rs.*;
import java.time.Instant;
import java.util.*;
import org.keycloak.connections.jpa.JpaConnectionProvider;
import org.keycloak.models.*;
import org.keycloak.email.EmailTemplateProvider;
import org.keycloak.events.*;

/** Durable, realm-bound capabilities. Row locks serialize claim, revoke and completion. */
final class RecoveryStore {
  static final String CREATE = "identity:users:recovery:create";
  static final String REVOKE = "identity:users:recovery:revoke";
  final KeycloakSession session;
  final RealmModel realm;
  final EntityManager em;
  RecoveryStore(KeycloakSession session) {
    this.session=session; realm=session.getContext().getRealm();
    em=session.getProvider(JpaConnectionProvider.class).getEntityManager();
  }
  static long now() { return Instant.now().toEpochMilli(); }
  static void eligible(RealmModel realm, UserModel target, UserModel actor) {
    if(target==null) throw new NotFoundException();
    if(actor==null || !actor.isEnabled() || !target.isEnabled() || actor.getId().equals(target.getId())
        || AuthenticationPolicy.isAdmin(realm,target)
        || realm.getRolesStream().filter(r -> r.getName().startsWith("admin-web:") && r.getName().endsWith(":access")).anyMatch(target::hasRole)
        || target.getServiceAccountClientLink()!=null
        || !target.isEmailVerified() || target.getEmail()==null || target.getEmail().isBlank())
      throw new ForbiddenException("Recovery requires an active account with verified email, different from your own and without administrative privileges.");
  }
  void available(RecoveryEntity value, String state) {
    if(value==null || !realm.getId().equals(value.realmId) || !state.equals(value.state) || value.expiresAt<=now())
      throw new ClientErrorException("This link has expired, was revoked or has already been used. Contact support.",410);
    var actor=session.users().getUserById(realm,value.actorId);
    var target=session.users().getUserById(realm,value.userId);
    eligible(realm,target,actor);
    var registry=AuthorizationResourceFactory.read(realm);
    var permission=realm.getRole(CREATE);
    var entry=realm.getRole("admin-web:"+value.environment+":access");
    if(registry==null || !value.environment.equals(registry.environment) || permission==null || entry==null
        || !actor.hasRole(permission) || !actor.hasRole(entry)) throw new ForbiddenException("Support authorization is no longer valid.");
  }
  RecoveryEntity get(String id) {
    var value=em.find(RecoveryEntity.class,id,LockModeType.PESSIMISTIC_WRITE);
    if(value==null || !realm.getId().equals(value.realmId)) throw new NotFoundException();
    // A token lookup may already have loaded this entity before waiting for the row lock.
    em.refresh(value,LockModeType.PESSIMISTIC_WRITE);
    return value;
  }
  RecoveryEntity bySecret(String raw, boolean browser) {
    if(raw==null || !raw.matches("[A-Za-z0-9_-]{43}")) throw new NotFoundException();
    var values=em.createQuery("select r.id from RecoveryEntity r where r.realmId=:realm and r."+(browser ? "sessionHash" : "tokenHash")+"=:hash",String.class)
        .setParameter("realm",realm.getId()).setParameter("hash",InvitationStore.hash(raw)).getResultList();
    if(values.isEmpty()) throw new NotFoundException();
    return get(values.getFirst());
  }
  Map<String,Object> prepare(UserModel actor, String userId) {
    var target=session.users().getUserById(realm,userId); eligible(realm,target,actor);
    CredentialMutationLock.acquire(session,realm,target);
    var drafts=em.createQuery("select r from RecoveryEntity r where r.realmId=:realm and r.userId=:user and r.actorId=:actor and r.state='draft' and r.expiresAt>:now order by r.createdAt desc",RecoveryEntity.class)
        .setParameter("realm",realm.getId()).setParameter("user",userId).setParameter("actor",actor.getId()).setParameter("now",now()).setMaxResults(1).getResultList();
    var value=drafts.isEmpty() ? draft(actor,userId) : drafts.getFirst();
    return Map.of("id",value.id,"caseReference",value.caseReference,"expiresAt",value.expiresAt);
  }
  private RecoveryEntity draft(UserModel actor,String userId) {
    var value=new RecoveryEntity(); value.id=UUID.randomUUID().toString(); value.realmId=realm.getId(); value.userId=userId;
    value.actorId=actor.getId(); value.environment=AuthorizationResourceFactory.read(realm).environment;
    value.caseReference="SOP-"+value.id.toUpperCase(Locale.ROOT); value.createdAt=now(); value.expiresAt=value.createdAt+1_800_000;
    value.state="draft"; em.persist(value); return value;
  }
  Map<String,Object> issue(UserModel actor, String userId, String reason, String draftId) {
    if(reason==null || reason.trim().length()<10 || reason.length()>500)
      throw new BadRequestException("Enter a reason between 10 and 500 characters.");
    var target=session.users().getUserById(realm,userId); eligible(realm,target,actor);
    CredentialMutationLock.acquire(session,realm,target);
    RecoveryEntity value;
    if(draftId==null) value=draft(actor,userId); // Compatibility with previously deployed interfaces.
    else {
      value=get(draftId);
      if(!userId.equals(value.userId) || !actor.getId().equals(value.actorId)) throw new ForbiddenException("The support reference does not match this operation.");
      if(!"draft".equals(value.state) || value.expiresAt<=now()) throw new ClientErrorException("The support reference has expired or was used. Reopen the form.",409);
      if(!value.environment.equals(AuthorizationResourceFactory.read(realm).environment)) throw new ForbiddenException("Invalid recovery environment.");
    }
    if(!session.singleUseObjects().putIfAbsent("tentu-recovery-actor:"+realm.getId()+":"+actor.getId(),30))
      throw new ClientErrorException("Wait 30 seconds before generating another link.",429);
    // Update entities under locks so an in-flight completion cannot resurrect a replaced link.
    var previous=em.createQuery("select r from RecoveryEntity r where r.realmId=:realm and r.userId=:user and r.state in ('issued','claimed')",RecoveryEntity.class)
        .setParameter("realm",realm.getId()).setParameter("user",userId).setLockMode(LockModeType.PESSIMISTIC_WRITE).getResultList();
    previous.forEach(previousValue -> previousValue.state="revoked");
    String token=InvitationStore.token();
    value.reason=reason.trim(); value.tokenHash=InvitationStore.hash(token);
    value.createdAt=now(); value.expiresAt=value.createdAt+600_000; value.state="issued";
    notify(target,"issued"); event(value,"issued");
    String url=session.getContext().getUri().getBaseUriBuilder().path("realms").path(realm.getName()).path("tentu-recovery").build().toString();
    return Map.of("id",value.id,"url",url+"#"+token,"expiresAt",value.expiresAt,"state",value.state,"caseReference",value.caseReference);
  }
  void notify(UserModel target, String phase) {
    try { session.getProvider(EmailTemplateProvider.class).setRealm(realm).setUser(target)
        .send("tentuRecoverySubject","recovery-notification.ftl",new HashMap<>(Map.of("phase",phase))); }
    catch(Exception error) { session.getTransactionManager().setRollbackOnly(); throw new ServiceUnavailableException("The account owner could not be notified. The action was not completed."); }
  }
  void event(RecoveryEntity value, String phase) { event(value,phase,value.actorId); }
  void event(RecoveryEntity value, String phase, String actorId) {
    new EventBuilder(realm,session,session.getContext().getConnection()).event(EventType.CUSTOM_REQUIRED_ACTION)
        .user(value.userId).detail("recovery_id",value.id).detail("support_actor",actorId)
        .detail("support_case",value.caseReference).detail("recovery_state",phase).success();
  }
}
