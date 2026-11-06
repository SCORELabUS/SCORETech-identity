package es.tentuplaza.identity.emailotp;

import org.keycloak.Config;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.AuthenticatorFactory;
import org.keycloak.models.AuthenticationExecutionModel.Requirement;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.provider.ProviderConfigProperty;

public final class EmailOtpAuthenticatorFactory implements AuthenticatorFactory {
  public static final String ID = "tentu-email-otp";
  private static final Requirement[] REQUIREMENTS = {Requirement.REQUIRED, Requirement.DISABLED};

  @Override public String getId() { return ID; }
  @Override public String getDisplayType() { return "SCORE email OTP passwordless"; }
  @Override public String getReferenceCategory() { return "email-otp"; }
  @Override public boolean isConfigurable() { return false; }
  @Override public Requirement[] getRequirementChoices() { return REQUIREMENTS; }
  @Override public boolean isUserSetupAllowed() { return false; }
  @Override public String getHelpText() { return "Registers or signs in users after a one-time email code."; }
  @Override public Authenticator create(KeycloakSession session) { return EmailOtpAuthenticator.INSTANCE; }
  @Override public void init(Config.Scope config) { }
  @Override public void postInit(KeycloakSessionFactory factory) { }
  @Override public void close() { }
  @Override public java.util.List<ProviderConfigProperty> getConfigProperties() { return java.util.List.of(); }
}
