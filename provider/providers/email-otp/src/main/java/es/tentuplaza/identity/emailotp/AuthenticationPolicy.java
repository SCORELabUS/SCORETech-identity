package es.tentuplaza.identity.emailotp;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.BiConsumer;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.sessions.AuthenticationSessionModel;

/** Only server-owned session notes attest to authentication; user attributes cannot. */
public final class AuthenticationPolicy {
  public static final String PASSKEY = "webauthn-passwordless";
  public static final String METHOD = "tentu.auth.method";
  public static final String ADMIN = "tentu.auth.admin";
  public static final String REGISTER = "tentu-register-passkey";
  private static final List<String> ADMINISTRATIVE_ROLES = List.of(
      "administrador", "admin-web:local:access", "admin-web:staging:access", "admin-web:production:access");
  private AuthenticationPolicy() { }
  public static boolean isAdmin(RealmModel realm, UserModel user) {
    if (user == null) return false;
    for (String name : ADMINISTRATIVE_ROLES) {
      var role = realm.getRole(name);
      if (role != null && user.hasRole(role)) return true;
    }
    return false;
  }
  public static boolean hasPasskey(UserModel user) {
    return user != null && user.credentialManager().isConfiguredFor(PASSKEY);
  }
  public static void record(AuthenticationSessionModel auth, RealmModel realm, UserModel user, String method) {
    auth.setUserSessionNote(METHOD, method);
    auth.setUserSessionNote(ADMIN, Boolean.toString(isAdmin(realm, user) && PASSKEY.equals(method)));
  }
  /** Adapt success only. All validation, errors and credential management remain native. */
  public static <T> T onSuccess(Class<T> contract, T delegate, Runnable success) {
    return intercept(contract, delegate, name -> { if (name.equals("success")) success.run(); });
  }
  public static <T> T intercept(Class<T> contract, T delegate, Consumer<String> before) {
    return observe(contract, delegate, (name, args) -> before.accept(name));
  }
  public static <T> T observe(Class<T> contract, T delegate, BiConsumer<String, Object[]> before) {
    return contract.cast(Proxy.newProxyInstance(contract.getClassLoader(), new Class<?>[]{contract}, (proxy, method, args) -> {
      before.accept(method.getName(), args);
      try { return method.invoke(delegate, args); }
      catch (InvocationTargetException error) { throw error.getCause(); }
    }));
  }
}
