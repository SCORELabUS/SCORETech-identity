package es.tentuplaza.identity.emailotp;

import java.util.Set;
import org.keycloak.Config;
import org.keycloak.events.*;
import org.keycloak.events.admin.*;
import org.keycloak.models.*;
import org.keycloak.email.EmailTemplateProvider;
import org.jboss.logging.Logger;
import java.lang.reflect.Proxy;
import java.lang.reflect.InvocationTargetException;
import java.util.Map;

/** Revoke sessions at privilege changes and notify the old address after confirmed changes. */
public final class SecurityEventsFactory implements EventListenerProviderFactory {
  private static final Logger LOG = Logger.getLogger(SecurityEventsFactory.class);
  public String getId() { return "tentu-security-events"; }
  public EventListenerProvider create(KeycloakSession session) {
    return new EventListenerProvider() {
      public void onEvent(Event event) {
        if (event.getType() != EventType.UPDATE_EMAIL || event.getError() != null || event.getDetails() == null) return;
        String oldEmail = event.getDetails().get(Details.PREVIOUS_EMAIL);
        var realm = session.realms().getRealm(event.getRealmId());
        var user = session.users().getUserById(realm, event.getUserId());
        if (oldEmail == null || user == null || oldEmail.equals(user.getEmail())) return;
        var previousUser = (UserModel) Proxy.newProxyInstance(UserModel.class.getClassLoader(), new Class<?>[]{UserModel.class}, (proxy, method, args) -> {
          if (method.getName().equals("getEmail")) return oldEmail;
          try { return method.invoke(user, args); } catch (InvocationTargetException error) { throw error.getCause(); }
        });
        try {
          session.getProvider(EmailTemplateProvider.class).setRealm(realm).setUser(previousUser)
            .send("tentuEmailChangedSubject", "email-changed.ftl", new java.util.HashMap<>());
        } catch (Exception error) {
          // No SMTP diagnostics, addresses, action links or token values in logs.
          LOG.warn("Previous-address security notification failed");
        }
      }
      public void onEvent(AdminEvent event, boolean includeRepresentation) {
        if (event.getError() != null || event.getResourcePath() == null) return;
        var path = event.getResourcePath();
        var realm = session.realms().getRealm(event.getRealmId());
        if (realm == null) return;
        if (path.startsWith("users/") && (path.contains("/role-mappings") || path.contains("/groups/"))) {
          String id = path.split("/")[1];
          var user = session.users().getUserById(realm, id);
          if (user != null) {
            session.sessions().removeUserSessions(realm, user);
            session.sessions().getOfflineUserSessionsStream(realm, user).toList().forEach(s -> session.sessions().removeOfflineUserSession(realm, s));
          }
        } else if (((path.startsWith("roles/") || path.startsWith("roles-by-id/")) && (path.contains("/composites") || event.getOperationType() == OperationType.DELETE)) ||
            (path.startsWith("groups/") && (path.contains("/role-mappings") || event.getOperationType() == OperationType.UPDATE || event.getOperationType() == OperationType.DELETE))) {
          // Composite/group edits can change effective privileges for many users.
          session.sessions().readOnlyStreamOfflineUserSessions(realm).toList().forEach(s -> session.sessions().removeOfflineUserSession(realm, s));
          session.sessions().removeUserSessions(realm);
        }
      }
      public void close() { }
    };
  }
  public void init(Config.Scope config) { }
  public void postInit(KeycloakSessionFactory factory) { }
  public void close() { }
}
