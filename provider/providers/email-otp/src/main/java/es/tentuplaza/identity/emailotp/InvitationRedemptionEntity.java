package es.tentuplaza.identity.emailotp;
import jakarta.persistence.*;
@Entity @Table(name="TENTU_INVITATION_REDEMPTION", uniqueConstraints=@UniqueConstraint(columnNames={"REALM_ID","USER_ID"}))
public class InvitationRedemptionEntity {
  @Id @Column(name="ID", length=36) public String id;
  @Column(name="INVITATION_ID", nullable=false, length=36) public String invitationId;
  @Column(name="REALM_ID", nullable=false, length=36) public String realmId;
  @Column(name="USER_ID", nullable=false, length=36) public String userId;
  @Column(name="COMPLETED_AT", nullable=false) public long completedAt;
  @Column(name="ROLE_NAMES", nullable=false, length=16000) public String roleNames;
  @Column(name="CATALOGUE_REVISION", nullable=false, length=64) public String catalogueRevision;
}
