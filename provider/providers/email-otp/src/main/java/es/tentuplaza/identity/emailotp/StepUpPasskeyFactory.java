package es.tentuplaza.identity.emailotp;

import java.time.Instant;
import com.webauthn4j.WebAuthnAuthenticationManager;
import com.webauthn4j.data.client.Origin;
import com.webauthn4j.server.ServerProperty;
import com.webauthn4j.verifier.OriginVerifierImpl;
import org.keycloak.credential.*;
import org.keycloak.models.*;

/** Native signature/counter/UV validation, with a ticket-bound top origin for embedded step-up only. */
public final class StepUpPasskeyFactory extends WebAuthnPasswordlessCredentialProviderFactory {
  @Override public int order() { return 10; }
  @Override public CredentialProvider create(KeycloakSession session) {
    return new WebAuthnPasswordlessCredentialProvider(session, getMetadataService(), createOrGetObjectConverter()) {
      @Override public boolean isValid(RealmModel realm, UserModel user, CredentialInput input) {
        // Credential providers can be cached before the step-up ticket is bound.
        // Resolve the active authentication session at validation time.
        var auth = session.getContext().getAuthenticationSession();
        if (auth == null || auth.getAuthNote(StepUpResourceFactory.NOTE) == null)
          return super.isValid(realm, user, input);
        String origin = auth.getAuthNote("tentu.step-up.origin");
        if (origin == null || !user.isEnabled() || !user.getId().equals(auth.getAuthNote("tentu.step-up.user"))
            || Long.parseLong(auth.getAuthNote("tentu.step-up.expires")) <= Instant.now().toEpochMilli()
            || session.sessions().getUserSession(realm, auth.getAuthNote("tentu.step-up.session")) == null
            || !(input instanceof WebAuthnCredentialModelInput assertion)) return false;
        var previous = assertion.getAuthenticationParameters().getServerProperty();
        var property = ServerProperty.builder().originPredicate(previous.getOriginPredicate()).rpId(previous.getRpId())
            .challenge(previous.getChallenge()).topOrigin(new Origin(origin)).build();
        assertion.setAuthenticationParameters(new WebAuthnCredentialModelInput.KeycloakWebAuthnAuthenticationParameters(property, true));
        return super.isValid(realm, user, assertion);
      }
      @Override protected WebAuthnAuthenticationManager getWebAuthnAuthenticationManager() {
        var manager = super.getWebAuthnAuthenticationManager();
        var auth = session.getContext().getAuthenticationSession();
        if (auth == null || auth.getAuthNote(StepUpResourceFactory.NOTE) == null) return manager;
        // Retain the provider's exact RP origin; do not accept arbitrary realm extra origins here.
        manager.getAuthenticationDataVerifier().setOriginVerifier(new OriginVerifierImpl());
        manager.getAuthenticationDataVerifier().setCrossOriginAllowed(true);
        return manager;
      }
    };
  }
}
