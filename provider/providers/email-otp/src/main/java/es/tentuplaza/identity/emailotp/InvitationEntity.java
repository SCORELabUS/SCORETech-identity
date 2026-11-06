package es.tentuplaza.identity.emailotp;
import jakarta.persistence.*;
@Entity @Table(name="TENTU_INVITATION", uniqueConstraints=@UniqueConstraint(columnNames="TOKEN_HASH"))
public class InvitationEntity {
  @Id @Column(name="ID", length=36) public String id;
  @Column(name="REALM_ID", nullable=false, length=36) public String realmId;
  @Column(name="ENVIRONMENT", nullable=false, length=16) public String environment;
  @Column(name="NAME", nullable=false, length=150) public String name;
  @Column(name="TOKEN_HASH", nullable=false, length=64) public String tokenHash;
  @Column(name="ROLE_NAMES", nullable=false, length=16000) public String roleNames;
  @Column(name="ROLE_FINGERPRINT", nullable=false, length=64) public String roleFingerprint;
  @Column(name="CATALOGUE_REVISION", nullable=false, length=64) public String catalogueRevision;
  @Column(name="CAPACITY", nullable=false) public int capacity;
  @Column(name="COMPLETED", nullable=false) public int completed;
  @Column(name="CREATOR", nullable=false, length=36) public String creator;
  @Column(name="CREATED_AT", nullable=false) public long createdAt;
  @Column(name="EXPIRES_AT") public Long expiresAt;
  @Column(name="REVOKED_AT") public Long revokedAt;
  @Version @Column(name="LOCK_VERSION", nullable=false) public long version;
}
