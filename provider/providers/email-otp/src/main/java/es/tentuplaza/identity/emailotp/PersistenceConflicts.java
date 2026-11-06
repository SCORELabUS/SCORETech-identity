package es.tentuplaza.identity.emailotp;

/** Recognize a database uniqueness race without exposing SQL or identifiers to the client. */
final class PersistenceConflicts {
  static boolean duplicate(Throwable error) {
    for (int depth = 0; error != null && depth < 20; depth++, error = error.getCause()) {
      if (error instanceof org.keycloak.models.ModelDuplicateException) return true;
      if (error instanceof java.sql.SQLException sql && "23505".equals(sql.getSQLState())) return true;
    }
    return false;
  }
}
