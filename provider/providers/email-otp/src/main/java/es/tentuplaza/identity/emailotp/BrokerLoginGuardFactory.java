package es.tentuplaza.identity.emailotp;

import java.util.List;
import org.keycloak.Config;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.AuthenticatorFactory;
import org.keycloak.models.*;
import org.keycloak.models.AuthenticationExecutionModel.Requirement;
import org.keycloak.provider.ProviderConfigProperty;

public final class BrokerLoginGuardFactory implements AuthenticatorFactory {
  public static final String ID = "score-broker-login-guard";
  public String getId() { return ID; }
  public String getDisplayType() { return "SCORE external identity policy"; }
  public String getReferenceCategory() { return "broker-policy"; }
  public boolean isConfigurable() { return false; }
  public Requirement[] getRequirementChoices() { return new Requirement[]{Requirement.REQUIRED, Requirement.DISABLED}; }
  public boolean isUserSetupAllowed() { return false; }
  public String getHelpText() { return "Preserves verified email, legal consent, baseline roles and administrative passkeys after external login."; }
  public Authenticator create(KeycloakSession session) { return new BrokerLoginGuard(); }
  public void init(Config.Scope scope) { }
  public void postInit(KeycloakSessionFactory factory) { }
  public void close() { }
  public List<ProviderConfigProperty> getConfigProperties() { return List.of(); }
}
