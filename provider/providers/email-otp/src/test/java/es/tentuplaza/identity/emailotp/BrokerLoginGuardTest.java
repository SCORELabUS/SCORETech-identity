package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.util.HashMap;
import java.util.Map;
import java.util.stream.Stream;
import jakarta.ws.rs.core.MultivaluedHashMap;
import org.junit.jupiter.api.Test;
import org.keycloak.authentication.*;
import org.keycloak.forms.login.LoginFormsProvider;
import org.keycloak.models.*;
import org.keycloak.sessions.AuthenticationSessionModel;

class BrokerLoginGuardTest {
  final AuthenticationFlowContext context = mock(AuthenticationFlowContext.class, RETURNS_DEEP_STUBS);
  final RealmModel realm = mock(RealmModel.class);
  final UserModel user = mock(UserModel.class, RETURNS_DEEP_STUBS);
  final AuthenticationSessionModel auth = mock(AuthenticationSessionModel.class);
  final LoginFormsProvider form = mock(LoginFormsProvider.class, RETURNS_SELF);
  final Map<String, String> notes = new HashMap<>();
  final MultivaluedHashMap<String, String> submitted = new MultivaluedHashMap<>();
  final BrokerLoginGuard guard = new BrokerLoginGuard();
  BrokerLoginGuardTest() {
    when(context.getRealm()).thenReturn(realm);
    when(context.getUser()).thenReturn(user);
    when(context.getAuthenticationSession()).thenReturn(auth);
    when(context.form()).thenReturn(form);
    when(context.getHttpRequest().getDecodedFormParameters()).thenReturn(submitted);
    when(realm.getClientsStream()).thenAnswer(invocation -> Stream.empty());
    when(user.isEnabled()).thenReturn(true);
    when(user.getId()).thenReturn("fixture-user");
    when(user.getEmail()).thenReturn("member@example.invalid");
    when(user.isEmailVerified()).thenReturn(true);
    when(user.getFirstAttribute("tentuTermsVersion")).thenReturn("2026-09");
    when(user.getFirstAttribute("tentuPrivacyVersion")).thenReturn("2026-09");
    when(auth.getAuthNote(anyString())).thenAnswer(i -> notes.get(i.getArgument(0)));
    doAnswer(i -> {notes.put(i.getArgument(0),i.getArgument(1));return null;}).when(auth).setAuthNote(anyString(),anyString());
    doAnswer(i -> notes.remove(i.getArgument(0))).when(auth).removeAuthNote(anyString());
  }
  @Test void memberLoginRecordsExternalButNeverAdministrativeAuthentication() {
    guard.authenticate(context);
    verify(auth).setUserSessionNote(AuthenticationPolicy.METHOD, "external");
    verify(auth).setUserSessionNote(AuthenticationPolicy.ADMIN, "false");
    verify(context).success();
    verify(user, never()).grantRole(any());
  }
  @Test void brokerMailboxDoesNotRequireRedundantVerification() {
    when(user.isEmailVerified()).thenReturn(false);
    guard.authenticate(context);
    verify(auth, never()).addRequiredAction(UserModel.RequiredAction.VERIFY_EMAIL);
    verify(auth).setAuthNote(BrokerLoginGuard.AUTHENTICATED_USER, "fixture-user");
    verify(user, never()).setEmailVerified(true);
  }
  @Test void unenrolledAdministratorCannotGainAttestationFromExternalLogin() {
    var role = mock(RoleModel.class);
    when(realm.getRole("administrador")).thenReturn(role);
    when(user.hasRole(role)).thenReturn(true);
    guard.authenticate(context);
    verify(auth).addRequiredAction(AuthenticationPolicy.REGISTER);
    verify(auth).setUserSessionNote(AuthenticationPolicy.ADMIN, "false");
    verify(auth, never()).setUserSessionNote(AuthenticationPolicy.ADMIN, "true");
  }
  @Test void incompleteAccountMustAcceptBothPublishedReferences() {
    when(user.getFirstAttribute("tentuTermsVersion")).thenReturn(null);
    guard.authenticate(context);
    verify(form).createForm("broker-consent.ftl");
    verify(context, never()).success();
    submitted.putSingle("terms", "true");
    guard.action(context);
    verify(user, never()).setSingleAttribute(eq("tentuTermsVersion"), anyString());
    submitted.putSingle("privacy", "true");
    guard.action(context);
    verify(user).setSingleAttribute("tentuTermsVersion", "2026-09");
    verify(user).setSingleAttribute("tentuPrivacyVersion", "2026-09");
    verify(context).success();
  }
  @Test void brokerRegistrationGrantsOnlyConfiguredBaselineRole() {
    notes.put(BrokerLoginGuard.NEW_USER,"true");
    var role = mock(RoleModel.class);
    when(realm.getAttribute(RegistrationPolicy.DEFAULT_ROLE)).thenReturn("member");
    when(realm.getRole("member")).thenReturn(role);
    guard.authenticate(context);
    verify(user).grantRole(role);
    assertFalse(notes.containsKey(BrokerLoginGuard.NEW_USER));
  }
  @Test void existingAccountsNeverReceiveRegistrationRoleAgain() {
    when(realm.getAttribute(RegistrationPolicy.DEFAULT_ROLE)).thenReturn("member");
    guard.authenticate(context);
    verify(user,never()).grantRole(any());
  }
  @Test void abandonedBrokerRegistrationRemainsProvisionalForLocalEmailLogin() {
    notes.put(BrokerLoginGuard.NEW_USER,"true");
    when(user.getFirstAttribute("tentuTermsVersion")).thenReturn(null);
    guard.authenticate(context);
    verify(user).setSingleAttribute(InvitationStore.PROVISIONAL,"true");
    verify(user).setSingleAttribute(BrokerLoginGuard.PENDING,"true");
    verify(user,never()).removeAttribute(InvitationStore.PROVISIONAL);
    verify(context,never()).success();
  }
  @Test void resumedBrokerOnboardingReceivesSafeDefaultAfterConsent() {
    when(user.getFirstAttribute(BrokerLoginGuard.PENDING)).thenReturn("true");
    var role = mock(RoleModel.class);
    when(realm.getAttribute(RegistrationPolicy.DEFAULT_ROLE)).thenReturn("member");
    when(realm.getRole("member")).thenReturn(role);
    guard.authenticate(context);
    verify(user).grantRole(role);
    verify(user).removeAttribute(BrokerLoginGuard.PENDING);
    verify(user).removeAttribute(InvitationStore.PROVISIONAL);
  }
  @Test void disabledAndMissingMailboxUsersFailClosed() {
    when(user.isEnabled()).thenReturn(false);
    guard.authenticate(context);
    verify(context).failureChallenge(eq(AuthenticationFlowError.ACCESS_DENIED),any());
    verify(context,never()).success();
  }
  @Test void forgedConsentPostCannotCompleteLogin() {
    submitted.putSingle("terms","true");
    submitted.putSingle("privacy","true");
    guard.action(context);
    verify(context).failureChallenge(eq(AuthenticationFlowError.ACCESS_DENIED),any());
    verify(context,never()).success();
  }
}
