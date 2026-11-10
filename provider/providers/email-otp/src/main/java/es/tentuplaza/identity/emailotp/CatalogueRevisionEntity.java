package es.tentuplaza.identity.emailotp;
import jakarta.persistence.*;
/** Audit and restorable role definitions, committed with the native authorization registry. */
@Entity @Table(name="SCORE_CATALOGUE_REVISION")
public class CatalogueRevisionEntity {
  @Id @Column(name="ID", length=64) public String id;
  @Column(name="REALM_ID", length=36, nullable=false) public String realmId;
  @Column(name="ENVIRONMENT", length=16, nullable=false) public String environment;
  @Column(name="CREATED_AT", nullable=false) public long createdAt;
  @Column(name="ACTOR", length=200, nullable=false) public String actor;
  @Column(name="REASON", length=300, nullable=false) public String reason;
  @Column(name="OPERATION", length=16, nullable=false) public String operation;
  @Column(name="CATALOGUE", columnDefinition="text", nullable=false) public String catalogue;
}
