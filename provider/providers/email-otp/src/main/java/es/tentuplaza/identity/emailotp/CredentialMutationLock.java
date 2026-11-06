package es.tentuplaza.identity.emailotp;

import jakarta.ws.rs.ClientErrorException;
import org.keycloak.models.*;

/** Shared cache exclusion covers both support and self-service transactions. */
final class CredentialMutationLock {
  static void acquire(KeycloakSession session, RealmModel realm, UserModel user) {
    String key = "tentu-credential-mutation:" + realm.getId() + ":" + user.getId();
    if (!session.singleUseObjects().putIfAbsent(key, 900))
      throw new ClientErrorException("A sign-in method is already being changed. Try again shortly.", 409);
    session.getTransactionManager().enlistAfterCompletion(new AbstractKeycloakTransaction() {
      protected void commitImpl() { session.singleUseObjects().remove(key); }
      protected void rollbackImpl() { session.singleUseObjects().remove(key); }
    });
  }
}
