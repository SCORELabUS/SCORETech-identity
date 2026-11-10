package es.tentuplaza.identity.emailotp;

import java.util.Map;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.*;
import org.keycloak.Config;
import org.keycloak.models.*;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.services.resource.*;

public final class IdentityLinksResourceFactory implements RealmResourceProviderFactory {
  public String getId() { return "score-identities"; }
  public RealmResourceProvider create(KeycloakSession session) { return new RealmResourceProvider() {
    public Object getResource() { return new Resource(session); }
    public void close() { }
  }; }
  public static final class Resource {
    private final KeycloakSession session;
    Resource(KeycloakSession session) { this.session=session; }
    @GET @Produces(MediaType.APPLICATION_JSON)
    public Response list() {
      var realm=session.getContext().getRealm();
      var auth=new AppAuthManager.BearerTokenAuthenticator(session).setAudience("identity-account-api").authenticate();
      StepUpResourceFactory.authorizeScope(realm,auth,"self:security");
      return Response.ok(Map.of("providers",IdentityLinks.list(session,realm,auth.getUser())))
          .header("Cache-Control","no-store").build();
    }
  }
  public void init(Config.Scope config) { }
  public void postInit(KeycloakSessionFactory factory) { }
  public void close() { }
}
