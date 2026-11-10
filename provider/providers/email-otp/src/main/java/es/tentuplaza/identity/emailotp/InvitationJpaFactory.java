package es.tentuplaza.identity.emailotp;
import java.util.List;
import org.keycloak.Config;
import org.keycloak.models.*;
import org.keycloak.connections.jpa.entityprovider.*;
public final class InvitationJpaFactory implements JpaEntityProviderFactory {
  public String getId() { return "tentu-invitations"; }
  public JpaEntityProvider create(KeycloakSession session) {
    return new JpaEntityProvider() {
      public List<Class<?>> getEntities() { return List.of(InvitationEntity.class, InvitationRedemptionEntity.class, RecoveryEntity.class, CatalogueRevisionEntity.class); }
      public String getChangelogLocation() { return "META-INF/tentu-invitations-changelog.xml"; }
      public String getFactoryId() { return "tentu-invitations"; }
      public void close() { }
    };
  }
  public void init(Config.Scope config) { }
  public void postInit(KeycloakSessionFactory factory) { }
  public void close() { }
}
