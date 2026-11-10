package es.tentuplaza.identity.emailotp;

import java.lang.reflect.Proxy;
import java.lang.reflect.InvocationTargetException;
import java.util.Map;
import org.keycloak.authentication.RequiredActionContext;
import org.keycloak.authentication.requiredactions.UpdateEmail;
import org.keycloak.authentication.actiontoken.updateemail.UpdateEmailActionToken;
import org.keycloak.email.EmailTemplateProvider;
import org.keycloak.jose.jws.JWSInput;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.UserModel;

/** Native UPDATE_EMAIL, with latest-request nonce and explicit pending cancellation. */
public final class LatestUpdateEmail extends UpdateEmail {
  @Override public int order() { return 10; }
  @Override public void requiredActionChallenge(RequiredActionContext context) {
    context.form().setAttribute("tentuEmailPending", context.getUser().getFirstAttribute(UserModel.EMAIL_PENDING) != null);
    super.requiredActionChallenge(context);
  }
  static String key(String realmId, String userId) { return "tentu-email-latest:" + realmId + ":" + userId; }
  @Override public void processAction(RequiredActionContext context) {
    String key = key(context.getRealm().getId(), context.getUser().getId());
    if ("true".equals(context.getHttpRequest().getDecodedFormParameters().getFirst("tentu-cancel-pending"))) {
      context.getSession().singleUseObjects().remove(key);
      context.getUser().removeAttribute(UserModel.EMAIL_PENDING);
      context.success(); return;
    }
    context.form().setAttribute("tentuEmailPending", context.getUser().getFirstAttribute(UserModel.EMAIL_PENDING) != null);
    var session = context.getSession();
    var wrappedSession = (KeycloakSession) Proxy.newProxyInstance(KeycloakSession.class.getClassLoader(), new Class<?>[]{KeycloakSession.class}, (proxy, method, args) -> {
      Object result;
      try { result = method.invoke(session, args); } catch (InvocationTargetException error) { throw error.getCause(); }
      if (method.getName().equals("getProvider") && args[0] == EmailTemplateProvider.class) {
        var mail = (EmailTemplateProvider) result;
        final Object[] wrapped = {null};
        wrapped[0] = Proxy.newProxyInstance(EmailTemplateProvider.class.getClassLoader(), new Class<?>[]{EmailTemplateProvider.class}, (mailProxy, mailMethod, mailArgs) -> {
          Object mailResult;
          try { mailResult = mailMethod.invoke(mail, mailArgs); } catch (InvocationTargetException error) { throw error.getCause(); }
          if (mailMethod.getName().equals("sendEmailUpdateConfirmation")) {
            var uri = java.net.URI.create((String) mailArgs[0]);
            String jwt = java.util.Arrays.stream(uri.getRawQuery().split("&")).filter(q -> q.startsWith("key=")).findFirst().orElseThrow().substring(4);
            var token = new JWSInput(java.net.URLDecoder.decode(jwt, java.nio.charset.StandardCharsets.UTF_8)).readJsonContent(UpdateEmailActionToken.class);
            long ttl = Math.max(1, token.getExp() - java.time.Instant.now().getEpochSecond());
            // Store only the opaque nonce; no code, email or signed action link.
            session.singleUseObjects().put(key, ttl, Map.of("nonce", token.getActionVerificationNonce().toString()));
          }
          return mailResult == mail ? wrapped[0] : mailResult;
        });
        return wrapped[0];
      }
      return result;
    });
    var wrappedContext = (RequiredActionContext) Proxy.newProxyInstance(RequiredActionContext.class.getClassLoader(), new Class<?>[]{RequiredActionContext.class}, (proxy, method, args) -> {
      if (method.getName().equals("getSession")) return wrappedSession;
      try { return method.invoke(context, args); } catch (InvocationTargetException error) { throw error.getCause(); }
    });
    super.processAction(wrappedContext);
  }
}
