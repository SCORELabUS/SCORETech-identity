package es.tentuplaza.identity.emailotp;

import jakarta.ws.rs.*;
import jakarta.ws.rs.core.Response;
import java.time.Instant;
import java.util.Map;
import org.keycloak.Config;
import org.keycloak.models.*;
import org.keycloak.services.resource.RealmResourceProvider;
import org.keycloak.services.resource.RealmResourceProviderFactory;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.services.managers.AuthenticationManager.AuthResult;
import org.keycloak.email.EmailTemplateProvider;
import org.keycloak.events.EventBuilder;
import org.keycloak.events.EventType;
import org.keycloak.events.Details;

/** User-token operations: never impersonation or a service-account password reset. */
public final class SupportResourceFactory implements RealmResourceProviderFactory {
  public String getId() { return "tentu-support"; }
  public RealmResourceProvider create(KeycloakSession session) {
    return new RealmResourceProvider() {
      public Object getResource() { return new Resource(session); }
      public void close() { }
    };
  }
  public void init(Config.Scope config) { }
  public void postInit(KeycloakSessionFactory factory) { }
  public void close() { }

  public static final class Resource {
    private final KeycloakSession session;
    Resource(KeycloakSession session) { this.session = session; }
    private AuthResult authorize(String permission, boolean recent) {
      var auth = new AppAuthManager.BearerTokenAuthenticator(session)
          .setAudience("identity-admin-api").authenticate();
      requireAuthorization(session.getContext().getRealm(), auth, permission, recent);
      return auth;
    }
    @DELETE @Path("users/{userId}/credentials/{credentialId}") @Consumes("application/json")
    public Response delete(@PathParam("userId") String userId, @PathParam("credentialId") String credentialId, Map<String, Object> body) {
      var auth = authorize("identity:users:credentials:delete", true);
      Object scope=auth.getToken().getOtherClaims().get("tentu_step_up");
      if(scope!=null && !scope.equals("user:"+userId+":credentials")) throw new ForbiddenException("This verification belongs to another action.");
      String reason = body != null && body.get("reason") instanceof String value ? value : null;
      if (body == null || !Boolean.TRUE.equals(body.get("confirmed"))) throw new BadRequestException("Confirm removal.");
      if (reason == null || reason.trim().length() < 10 || reason.length() > 500)
        throw new BadRequestException("Provide a reason between 10 and 500 characters.");
      var realm = session.getContext().getRealm();
      var target = session.users().getUserById(realm, userId);
      if (target == null) throw new NotFoundException();
      if (target.getId().equals(auth.getUser().getId())) throw new ForbiddenException("Use your profile to manage your own sign-in methods.");
      CredentialMutationLock.acquire(session, realm, target);
      removeCredential(session, realm, target, credentialId);
      new EventBuilder(realm, session, session.getContext().getConnection())
          .event(EventType.REMOVE_CREDENTIAL).user(target).session(auth.getSession())
          .client(auth.getClient()).detail(Details.CREDENTIAL_ID, credentialId)
          .detail("support_actor", auth.getUser().getId()).detail("support_reason", reason.trim()).success();
      return Response.noContent().header("Cache-Control", "no-store").build();
    }
    @POST @Path("users/{userId}/verification-request")
    public Response verification(@PathParam("userId") String userId) {
      var auth = authorize("identity:users:send-verification", false);
      var realm = session.getContext().getRealm();
      var user = session.users().getUserById(realm, userId);
      if (user == null) throw new NotFoundException();
      if (!user.isEnabled() || user.getEmail() == null || user.getEmail().isBlank() || user.isEmailVerified())
        throw new ClientErrorException("The account must be active and have an unverified email address.", 409);
      if (!session.singleUseObjects().putIfAbsent("tentu-support-verification-actor:" + realm.getId() + ":" + auth.getUser().getId(), 30))
        throw new ClientErrorException("Wait before requesting another email.", 429);
      if (!session.singleUseObjects().putIfAbsent("tentu-support-verification:" + realm.getId() + ":" + userId, 300))
        throw new ClientErrorException("Wait five minutes before requesting another email.", 429);
      return Response.noContent().header("Cache-Control", "no-store").build();
    }
  }

  static void requireAuthorization(RealmModel realm, AuthResult auth, String permission, boolean recent) {
      if (auth == null || auth.getSession() == null) throw new NotAuthorizedException("Bearer");
      var role = realm.getRole(permission);
      if (!"identity-admin-web".equals(auth.getToken().getIssuedFor())
          || role == null || !auth.getUser().hasRole(role)) throw new ForbiddenException("Permission required");
      // Live roles plus the signed token: revocation takes effect before a destructive action.
      var registry = AuthorizationResourceFactory.read(realm);
      if (registry == null || registry.environment == null)
        throw new ServiceUnavailableException("The applied authorization catalogue is unavailable.");
      String entry = "admin-web:" + registry.environment + ":access";
      var entryRole = realm.getRole(entry);
      var access = auth.getToken().getRealmAccess();
      if (entryRole == null || !auth.getUser().hasRole(entryRole)
          || access == null || !access.isUserInRole(entry))
        throw new ForbiddenException("Service access permission required");
      if (access == null || !access.isUserInRole(permission)) throw new ForbiddenException("Permission required");
      if (recent) {
        Long time = auth.getToken().getAuth_time();
        long now = Instant.now().getEpochSecond();
        if (time == null || time > now || now - time > 300
            || !AuthenticationPolicy.PASSKEY.equals(auth.getSession().getNote(AuthenticationPolicy.METHOD))
            || !AuthenticationPolicy.PASSKEY.equals(auth.getToken().getOtherClaims().get("tentu_auth_method")))
          throw new ForbiddenException("Verify your identity again with a passkey authenticated within the last five minutes.");
      }
  }

  static void removeCredential(KeycloakSession session, RealmModel realm, UserModel user, String id) {
    var credential = user.credentialManager().getStoredCredentialById(id);
    if (credential == null) throw new NotFoundException();
    String type = credential.getType();
    if (!AuthenticationPolicy.PASSKEY.equals(type) && !"otp".equals(type)) throw new BadRequestException("Unsupported sign-in method.");
    var remaining = user.credentialManager().getStoredCredentialsStream()
        .filter(c -> !id.equals(c.getId()))
        .filter(c -> AuthenticationPolicy.PASSKEY.equals(c.getType()) || "otp".equals(c.getType())).toList();
    if (remaining.isEmpty() || (AuthenticationPolicy.isAdmin(realm, user)
        && remaining.stream().noneMatch(c -> AuthenticationPolicy.PASSKEY.equals(c.getType()))))
      throw new ClientErrorException("Register another usable sign-in method first. The last administrative passkey cannot be removed.", 409);
    if (!user.credentialManager().removeStoredCredentialById(id)) throw new NotFoundException();
    if (user.getEmail() != null && !user.getEmail().isBlank()) {
      try {
        session.getProvider(EmailTemplateProvider.class).setRealm(realm).setUser(user)
            .send("tentuCredentialRemovedSubject", "credential-removed.ftl", new java.util.HashMap<>(Map.of("method", type)));
      } catch (Exception error) {
        // Fail closed: the request transaction must not commit an unnotified mutation.
        session.getTransactionManager().setRollbackOnly();
        throw new ServiceUnavailableException("Unable to send the notification. The sign-in method was not removed.");
      }
    } else {
      session.getTransactionManager().setRollbackOnly();
      throw new ClientErrorException("The account needs a notification channel before support can remove sign-in methods.", 409);
    }
  }
}
