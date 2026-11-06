package es.tentuplaza.identity.emailotp;
import jakarta.persistence.*;
@Entity @Table(name="TENTU_RECOVERY")
public class RecoveryEntity {
  @Id @Column(name="ID", length=36) public String id;
  @Column(name="REALM_ID", length=36) public String realmId;
  @Column(name="USER_ID", length=36) public String userId;
  @Column(name="ACTOR_ID", length=36) public String actorId;
  @Column(name="ENVIRONMENT", length=16) public String environment;
  @Column(name="REASON", length=500) public String reason;
  @Column(name="CASE_REFERENCE", length=150, updatable=false) public String caseReference;
  @Column(name="TOKEN_HASH", length=64) public String tokenHash;
  @Column(name="SESSION_HASH", length=64) public String sessionHash;
  @Column(name="STATE", length=16) public String state;
  @Column(name="ROOT_ID", length=128) public String rootId;
  @Column(name="TAB_ID", length=128) public String tabId;
  @Column(name="METHOD", length=64) public String method;
  @Column(name="CREATED_AT") public long createdAt;
  @Column(name="EXPIRES_AT") public long expiresAt;
  @Column(name="COMPLETED_AT") public Long completedAt;
  @Column(name="ATTEMPTS") public int attempts;
  @Version @Column(name="LOCK_VERSION") public long version;
}
