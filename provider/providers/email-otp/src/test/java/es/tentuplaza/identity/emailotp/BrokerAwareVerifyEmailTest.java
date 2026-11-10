package es.tentuplaza.identity.emailotp;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import org.junit.jupiter.api.Test;
import org.keycloak.authentication.RequiredActionContext;
import org.keycloak.models.UserModel;
class BrokerAwareVerifyEmailTest {
  RequiredActionContext context = mock(RequiredActionContext.class, RETURNS_DEEP_STUBS);
  BrokerAwareVerifyEmail action = new BrokerAwareVerifyEmail();
  BrokerAwareVerifyEmailTest() {
    when(context.getUser().getId()).thenReturn("member");
    when(context.getUser().getEmail()).thenReturn("member@example.invalid");
    when(context.getUser().isEnabled()).thenReturn(true);
    when(context.getUser().getRequiredActionsStream()).thenAnswer(i -> java.util.stream.Stream.empty());
    when(context.getRealm().isVerifyEmail()).thenReturn(true);
    when(context.getUser().isEmailVerified()).thenReturn(false);
  }
  @Test void ordinaryLoginStillRequiresMailboxOwnership() {
    action.evaluateTriggers(context);
    verify(context.getUser()).addRequiredAction(UserModel.RequiredAction.VERIFY_EMAIL);
  }
  @Test void authenticatedBrokerSkipsRedundantChallengeWithoutFalsifyingEmail() {
    when(context.getAuthenticationSession().getAuthNote(BrokerLoginGuard.AUTHENTICATED_USER)).thenReturn("member");
    action.evaluateTriggers(context); action.requiredActionChallenge(context);
    verify(context).success();
    verify(context.getUser(), never()).setEmailVerified(true);
    verify(context.getUser(), never()).addRequiredAction(UserModel.RequiredAction.VERIFY_EMAIL);
  }
  @Test void anotherUsersNoteCannotBypassVerification() {
    when(context.getAuthenticationSession().getAuthNote(BrokerLoginGuard.AUTHENTICATED_USER)).thenReturn("other");
    assertFalse(BrokerAwareVerifyEmail.authenticatedBroker(context));
    action.evaluateTriggers(context);
    verify(context.getUser()).addRequiredAction(UserModel.RequiredAction.VERIFY_EMAIL);
  }
  @Test void explicitlyRequestedVerificationRemainsNative() {
    when(context.getAuthenticationSession().getAuthNote(BrokerLoginGuard.AUTHENTICATED_USER)).thenReturn("member");
    when(context.getAuthenticationSession().getClientNote("kc_action")).thenReturn("VERIFY_EMAIL");
    assertFalse(BrokerAwareVerifyEmail.authenticatedBroker(context));
  }
}
