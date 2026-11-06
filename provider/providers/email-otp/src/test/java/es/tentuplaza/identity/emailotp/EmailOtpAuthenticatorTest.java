package es.tentuplaza.identity.emailotp;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import jakarta.ws.rs.core.MultivaluedHashMap;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.keycloak.authentication.*;
import org.keycloak.email.*;
import org.keycloak.models.*;
class EmailOtpAuthenticatorTest {
  static class Fixture {
    final AuthenticationFlowContext context = mock(AuthenticationFlowContext.class, RETURNS_DEEP_STUBS);
    final EmailTemplateProvider mail = mock(EmailTemplateProvider.class);
    final UserModel user = mock(UserModel.class, RETURNS_DEEP_STUBS);
    final Map<String,String> notes = new HashMap<>();
    final Map<String,Map<String,String>> cache = new HashMap<>();
    final MultivaluedHashMap<String,String> form = new MultivaluedHashMap<>();
    String code;
    Fixture() throws Exception {
      when(context.form()).thenReturn(mock(org.keycloak.forms.login.LoginFormsProvider.class, RETURNS_SELF));
      when(context.getHttpRequest().getDecodedFormParameters()).thenReturn(form);
      when(context.getUser()).thenReturn(user); when(user.getId()).thenReturn("user");
      when(user.getEmail()).thenReturn("person@example.invalid"); when(user.getFirstName()).thenReturn("Persona"); when(user.isEnabled()).thenReturn(true);
      when(context.getRealm().getId()).thenReturn("realm"); when(context.getRealm().getRole("administrador")).thenReturn(null);
      when(context.getAuthenticationSession().getParentSession().getId()).thenReturn("session");
      when(context.getSession().users().getUserByEmail(any(),eq("person@example.invalid"))).thenReturn(user);
      var session = context.getSession();
      when(session.keys().getActiveHmacKey(context.getRealm())).thenReturn(new KeyManager.ActiveHmacKey("fixture", new javax.crypto.spec.SecretKeySpec(new byte[32], "HmacSHA256")));
      when(context.getConnection().getRemoteAddr()).thenReturn("127.0.0.1");
      doReturn(mail).when(session).getProvider(EmailTemplateProvider.class);
      doReturn(mock(org.keycloak.connections.jpa.JpaConnectionProvider.class, RETURNS_DEEP_STUBS)).when(session).getProvider(org.keycloak.connections.jpa.JpaConnectionProvider.class);
      var auth = context.getAuthenticationSession();
      doAnswer(i -> { notes.put(i.getArgument(0),i.getArgument(1)); return null; }).when(auth).setAuthNote(anyString(),anyString());
      doAnswer(i -> { notes.remove(i.getArgument(0)); return null; }).when(auth).removeAuthNote(anyString());
      when(auth.getAuthNote(anyString())).thenAnswer(i -> notes.get(i.getArgument(0)));
      var objects = context.getSession().singleUseObjects();
      when(objects.putIfAbsent(anyString(),anyLong())).thenAnswer(i -> cache.putIfAbsent(i.getArgument(0),Map.of()) == null);
      doAnswer(i -> { cache.put(i.getArgument(0),i.getArgument(2)); return null; }).when(objects).put(anyString(),anyLong(),anyMap());
      when(objects.get(anyString())).thenAnswer(i -> cache.get(i.getArgument(0)));
      doAnswer(i -> { Map<String,Object> a=i.getArgument(3); code=a.get("code").toString(); assertTrue(code.matches("[0-9]{6}")); assertEquals(10L,a.get("minutes")); a.put("locale","en"); return null; }).when(mail).send(eq("emailOtpSubject"),anyList(),eq("email-otp.ftl"),anyMap());
    }
    void action(String stage) { form.putSingle("stage",stage); EmailOtpAuthenticator.INSTANCE.action(context); }
    void send() { form.putSingle("method","email"); action("select"); }
    void code(String value) { form.putSingle("code",value); action("verify"); }
    void admin(boolean passkey) { var role=mock(RoleModel.class); when(context.getRealm().getRole("administrador")).thenReturn(role); when(user.hasRole(role)).thenReturn(true); when(user.credentialManager().isConfiguredFor(AuthenticationPolicy.PASSKEY)).thenReturn(passkey); }
  }
  @Test void identificationStartsWithEmailWhenNoStrongerCredentialExists() throws Exception { var f=new Fixture(); f.form.putSingle("email","person@example.invalid"); f.action("identify"); verify(f.mail).send(anyString(),anyList(),anyString(),anyMap()); verify(f.context).challenge(any()); }
  @Test void recordsBoundedBrowserMetadataOnAuthenticationActions() throws Exception {
    var f = new Fixture();
    when(f.context.getHttpRequest().getHttpHeaders().getHeaderString("User-Agent")).thenReturn("x".repeat(600));
    f.send();
    verify(f.context.getEvent()).detail("user_agent", "x".repeat(512));
  }
  @Test void identificationStartsWithConfiguredTotpBeforeEmail() throws Exception { var f=new Fixture(); when(f.user.credentialManager().isConfiguredFor("otp")).thenReturn(true); f.form.putSingle("email","person@example.invalid"); f.action("identify"); verify(f.user.credentialManager(),atLeastOnce()).isConfiguredFor("otp"); verify(f.mail,never()).send(anyString(),anyList(),anyString(),anyMap()); verify(f.context).challenge(any()); }
  @Test void explicitChoiceSendsCodeAndRendererCanEnrichAttributes() throws Exception { var f=new Fixture(); f.send(); verify(f.mail).send(anyString(),anyList(),anyString(),anyMap()); verify(f.context).challenge(any()); }
  @Test void mailFailureNeverCompletesAuthentication() throws Exception { var f=new Fixture(); doThrow(new EmailException("failure")).when(f.mail).send(anyString(),anyList(),anyString(),anyMap()); f.send(); verify(f.context).failureChallenge(eq(AuthenticationFlowError.INTERNAL_ERROR),any()); verify(f.context,never()).success(); }
  @Test void wrongCodeStaysOnVerificationAndCorrectCodeIsConsumed() throws Exception { var f=new Fixture(); f.send(); f.code("invalid"); verify(f.context.form(),atLeastOnce()).setAttribute("stage","verify"); verify(f.context,never()).success(); f.code(f.code); f.code(f.code); verify(f.context,times(1)).success(); assertFalse(f.notes.containsKey("tentu.email_otp.hash")); }
  @Test void expiredCodeAndAttemptLimitRejectCorrectCode() throws Exception { var f=new Fixture(); f.send(); f.notes.put("tentu.email_otp.expires_at","1"); f.code(f.code); verify(f.context,never()).success(); var g=new Fixture(); g.send(); g.notes.put("tentu.email_otp.attempts","5"); g.code(g.code); verify(g.context,never()).success(); }
  @Test void cooldownPreventsResendAndOtherRequestInvalidatesOldCode() throws Exception { var f=new Fixture(); f.send(); f.action("resend"); verify(f.mail,times(1)).send(anyString(),anyList(),anyString(),anyMap()); f.cache.put("tentu-otp-active:"+EmailOtpRateLimit.recipientKey(f.context,"person@example.invalid"),Map.of("hash","other","session","other")); f.code(f.code); verify(f.context,never()).success(); }
  @Test void everySendEntryPointSharesCooldownAndPreservesOriginalCode() throws Exception {
    var first = new Fixture(); first.send(); first.send(); first.action("resend");
    verify(first.mail,times(1)).send(anyString(),anyList(),anyString(),anyMap());
    var next = new Fixture(); next.cache.putAll(first.cache);
    when(next.context.getAuthenticationSession().getParentSession().getId()).thenReturn("new-session");
    next.form.putSingle("email", "person@example.invalid"); next.action("identify");
    verify(next.mail,never()).send(anyString(), anyList(), anyString(), anyMap());
    verify(next.context.form()).setError("emailOtpResendWait");
    first.code(first.code); verify(first.context).success();
  }
  @Test void resendAfterCooldownSendsAndRestartsCooldown() throws Exception {
    var f = new Fixture(); f.send(); f.cache.remove("tentu-otp-send:"+EmailOtpRateLimit.recipientKey(f.context,"person@example.invalid"));
    f.action("resend"); f.action("resend");
    verify(f.mail, times(2)).send(anyString(), anyList(), anyString(), anyMap());
    verify(f.context.form()).setError("emailOtpResendWait");
  }
  @Test void repeatedIdentificationAndMethodNavigationPreserveTheIssuedCode() throws Exception {
    var f = new Fixture(); f.send(); f.action("methods"); f.send();
    f.form.putSingle("email", "person@example.invalid"); f.action("identify");
    verify(f.mail, times(1)).send(anyString(), anyList(), anyString(), anyMap());
    f.code(f.code); verify(f.context).success();
  }
  @Test void administratorWithPasskeyCannotChooseEmail() throws Exception { var f=new Fixture(); f.admin(true); f.send(); verify(f.mail,never()).send(anyString(),anyList(),anyString(),anyMap()); verify(f.context,never()).success(); }
  @Test void onboardingAddsRequiredRegistrationBeforeApplicationAccess() throws Exception { var f=new Fixture(); f.admin(false); f.send(); f.code(f.code); verify(f.context.getAuthenticationSession()).addRequiredAction(AuthenticationPolicy.REGISTER); verify(f.context.getAuthenticationSession()).setUserSessionNote(AuthenticationPolicy.ADMIN,"false"); }
  @Test void rememberMeChoiceIsNativeAndSurvivesLaterForms() throws Exception {
    var f = new Fixture(); when(f.context.getRealm().isRememberMe()).thenReturn(true);
    f.form.putSingle("email", "person@example.invalid"); f.form.putSingle("rememberMe", "on"); f.action("identify");
    assertEquals("true", f.notes.get(org.keycloak.events.Details.REMEMBER_ME));
    f.form.remove("rememberMe"); f.code("wrong"); f.action("resend");
    assertEquals("true", f.notes.get(org.keycloak.events.Details.REMEMBER_ME));
    f.action("identify"); assertNull(f.notes.get(org.keycloak.events.Details.REMEMBER_ME));
  }
  @Test void sensitiveActionsIgnorePostedRememberMeAndKeepOnlySameUserPreference() throws Exception {
    var f = new Fixture(); when(f.context.getRealm().isRememberMe()).thenReturn(true);
    when(f.context.getAuthenticationSession().getClientNote("kc_action")).thenReturn("CONFIGURE_TOTP");
    f.form.putSingle("email", "person@example.invalid"); f.form.putSingle("rememberMe", "on");
    f.action("identify"); assertNull(f.notes.get(org.keycloak.events.Details.REMEMBER_ME));
    f.notes.put("tentu.remember.previous_user", "user"); f.action("identify");
    assertEquals("true", f.notes.get(org.keycloak.events.Details.REMEMBER_ME));
    f.notes.put("tentu.remember.previous_user", "someone-else"); f.action("identify");
    assertNull(f.notes.get(org.keycloak.events.Details.REMEMBER_ME));
  }
  @Test void promptLoginAndMaxAgeZeroAreNotNormalLogin() throws Exception {
    var f = new Fixture(); assertTrue(EmailOtpAuthenticator.normalLogin(f.context));
    when(f.context.getAuthenticationSession().getClientNote("prompt")).thenReturn("login");
    assertFalse(EmailOtpAuthenticator.normalLogin(f.context));
    when(f.context.getAuthenticationSession().getClientNote("prompt")).thenReturn(null);
    when(f.context.getAuthenticationSession().getClientNote("max_age")).thenReturn("0");
    assertFalse(EmailOtpAuthenticator.normalLogin(f.context));
  }
  @Test void registrationIgnoresFiscalMarketingAndPhonePayloadWithoutWritingOrErasingThem() throws Exception {
    var f = new Fixture(); when(f.user.getFirstName()).thenReturn(""); f.send(); f.code(f.code);
    f.form.putSingle("firstName", "Test"); f.form.putSingle("lastName", "Person");
    f.form.putSingle("terms", "true"); f.form.putSingle("privacy", "true");
    f.form.putSingle("taxDocumentType", "PASSPORT");
    f.form.putSingle("taxDocumentNumber", "invalid-document");
    f.form.putSingle("phone", "not-a-phone"); f.form.putSingle("marketing", "true");
    f.action("register");
    for (var attribute : List.of("tentuTaxDocumentType", "tentuTaxDocumentNumber", "tentuPhone", "tentuMarketing")) {
      verify(f.user, never()).setSingleAttribute(eq(attribute), anyString());
      verify(f.user, never()).removeAttribute(attribute);
    }
    verify(f.user).setFirstName("Test"); verify(f.user).setLastName("Person");
    verify(f.context).success();
  }
  @Test void unknownEmailCreatesNoAccountBeforeVerifiedConsentedRegistrationAndGetsNoDefaultAccess() throws Exception {
    var f = new Fixture(); when(f.context.getUser()).thenReturn(null);
    when(f.context.getSession().users().getUserByEmail(any(), anyString())).thenReturn(null);
    f.form.putSingle("email", "new@example.invalid"); f.action("identify");
    verify(f.context.getSession().users(), never()).addUser(any(), anyString());
    f.code(f.code); verify(f.context.getSession().users(), never()).addUser(any(), anyString());
    f.form.putSingle("firstName", "Test"); f.form.putSingle("lastName", "Person");
    f.action("register");
    verify(f.context.form()).setError("emailOtpConsentRequired");
    verify(f.context.getSession().users(), never()).addUser(any(), anyString());
    verify(f.context, never()).success();
    var defaultRole = mock(RoleModel.class);
    when(f.context.getRealm().getAttribute(RegistrationPolicy.DEFAULT_ROLE)).thenReturn("admin-web:local:access");
    when(f.context.getRealm().getRole("admin-web:local:access")).thenReturn(defaultRole);
    when(f.context.getSession().users().addUser(eq(f.context.getRealm()), startsWith("score-"))).thenReturn(f.user);
    f.form.putSingle("terms", "true"); f.form.putSingle("privacy", "true"); f.action("register");
    verify(f.context.getSession().users()).addUser(eq(f.context.getRealm()), startsWith("score-"));
    verify(f.user).setEmail("new@example.invalid"); verify(f.user).setEmailVerified(true);
    verify(f.context).success(); verify(f.user, never()).grantRole(any());
  }
  @Test void completingExistingProfileDoesNotApplyRegistrationDefault() throws Exception {
    var f = new Fixture(); when(f.user.getFirstName()).thenReturn(""); f.send(); f.code(f.code);
    when(f.context.getRealm().getAttribute(RegistrationPolicy.DEFAULT_ROLE)).thenReturn("admin-web:local:access");
    f.form.putSingle("firstName", "Test"); f.form.putSingle("lastName", "Person");
    f.form.putSingle("terms", "true"); f.form.putSingle("privacy", "true"); f.action("register");
    verify(f.context).success(); verify(f.user, never()).grantRole(any());
  }
  @Test void invalidLegacyDefaultCannotBlockPublicRegistrationOrGrantAccess() throws Exception {
    var f = new Fixture(); when(f.context.getUser()).thenReturn(null);
    when(f.context.getSession().users().getUserByEmail(any(), anyString())).thenReturn(null);
    when(f.context.getSession().users().addUser(eq(f.context.getRealm()), startsWith("score-"))).thenReturn(f.user);
    f.form.putSingle("email", "new@example.invalid"); f.action("identify"); f.code(f.code);
    f.form.putSingle("firstName", "Test"); f.form.putSingle("lastName", "Person");
    f.form.putSingle("terms", "true"); f.form.putSingle("privacy", "true");
    when(f.context.getRealm().getAttribute(RegistrationPolicy.DEFAULT_ROLE)).thenReturn("missing");
    when(f.context.getRealm().getRole("missing")).thenReturn(null);
    f.action("register");
    verify(f.context).success(); verify(f.user, never()).grantRole(any());
  }
  @Test void invitationCompletionPreservesOnlyTheRolesAuthorizedByRedemption() throws Exception {
    var f = new Fixture(); when(f.user.getFirstName()).thenReturn("");
    when(f.user.getFirstAttribute(InvitationStore.PROVISIONAL)).thenReturn("true");
    var invitedRole = mock(RoleModel.class); var defaultRole = mock(RoleModel.class);
    var access = mock(RoleModel.class); var creator = mock(UserModel.class);
    var manageRoles = mock(RoleModel.class); var createInvitations = mock(RoleModel.class);
    var realm = f.context.getRealm(); var session = f.context.getSession();
    when(session.getContext().getRealm()).thenReturn(realm);
    when(realm.getAttribute("tentu.invitations.enabled")).thenReturn("true");
    when(invitedRole.getName()).thenReturn("researcher"); when(invitedRole.getId()).thenReturn("researcher-id");
    when(invitedRole.isComposite()).thenReturn(true);
    when(invitedRole.getCompositesStream()).thenAnswer(invocation -> java.util.stream.Stream.of(access));
    when(access.getName()).thenReturn("demo:local:access"); when(access.getId()).thenReturn("demo-access-id");
    when(realm.getRole("researcher")).thenReturn(invitedRole);
    when(realm.getRole("identity:users:update:roles")).thenReturn(manageRoles);
    when(realm.getRole("identity:invitations:create")).thenReturn(createInvitations);
    when(creator.isEnabled()).thenReturn(true);
    when(creator.hasRole(manageRoles)).thenReturn(true);
    when(creator.hasRole(createInvitations)).thenReturn(true);
    when(creator.hasRole(access)).thenReturn(true);
    when(session.users().getUserById(realm, "invitation-creator")).thenReturn(creator);
    var registry = new AuthorizationResourceFactory.Registry();
    registry.environment = "local"; registry.revision = "catalogue-fixture";
    var roleDefinition = new AuthorizationResourceFactory.Role(); roleDefinition.name = "researcher";
    roleDefinition.permissions = List.of("demo:local:access"); registry.roles = List.of(roleDefinition);
    var permission = new AuthorizationResourceFactory.Permission(); permission.name = "demo:local:access";
    permission.owner = "demo"; registry.permissions = List.of(permission);
    when(realm.getAttribute(AuthorizationResourceFactory.ACTIVE)).thenReturn(AuthorizationResourceFactory.serialize(registry));
    var entityManager = session.getProvider(org.keycloak.connections.jpa.JpaConnectionProvider.class).getEntityManager();
    var previousRedemptions = mock(jakarta.persistence.TypedQuery.class, RETURNS_SELF);
    when(entityManager.createQuery(anyString(), eq(InvitationRedemptionEntity.class))).thenReturn(previousRedemptions);
    when(previousRedemptions.getResultList()).thenReturn(List.of());
    var invitation = new InvitationEntity(); invitation.id = "invitation-fixture"; invitation.realmId = "realm";
    invitation.creator = "invitation-creator"; invitation.roleNames = "researcher"; invitation.capacity = 2;
    invitation.roleFingerprint = new InvitationStore(session).fingerprint(List.of("researcher"));
    when(entityManager.find(InvitationEntity.class, invitation.id, jakarta.persistence.LockModeType.PESSIMISTIC_WRITE))
        .thenReturn(invitation);
    when(f.context.getRealm().getAttribute(RegistrationPolicy.DEFAULT_ROLE)).thenReturn("admin-web:local:access");
    when(f.context.getRealm().getRole("admin-web:local:access")).thenReturn(defaultRole);
    f.send(); f.code(f.code);
    f.notes.put(InvitationStore.NOTE, "invitation-fixture");
    f.form.putSingle("firstName", "Test"); f.form.putSingle("lastName", "Person");
    f.form.putSingle("terms", "true"); f.form.putSingle("privacy", "true");
    f.action("register");
    verify(f.context).success(); verify(f.user).grantRole(invitedRole);
    verify(f.user, never()).grantRole(defaultRole); verify(f.user, never()).deleteRoleMapping(any());
    assertEquals(1, invitation.completed);
    var evidence = org.mockito.ArgumentCaptor.forClass(InvitationRedemptionEntity.class);
    verify(entityManager).persist(evidence.capture());
    assertEquals("researcher", evidence.getValue().roleNames);
    assertEquals("user", evidence.getValue().userId);
    assertEquals("catalogue-fixture", evidence.getValue().catalogueRevision);
  }
  @Test void invalidNamesAndExpiredRegistrationProofCannotWriteUser() throws Exception {
    var f=new Fixture(); when(f.user.getFirstName()).thenReturn(""); f.send(); f.code(f.code);
    f.form.putSingle("firstName","x".repeat(101)); f.form.putSingle("lastName","Prueba"); f.action("register");
    verify(f.user,never()).setFirstName(anyString());
    f.form.putSingle("firstName","Persona"); f.notes.put("tentu.registration.expires","1"); f.action("register");
    verify(f.context,never()).success();
  }
  @Test void accountAppearingDuringPreRegistrationMustAuthenticateItsOwnMethods() throws Exception {
    var f=new Fixture(); when(f.context.getUser()).thenReturn(null);
    when(f.context.getSession().users().getUserByEmail(any(),anyString())).thenReturn(null);
    f.form.putSingle("email","person@example.invalid"); f.action("identify"); f.code(f.code);
    when(f.context.getSession().users().getUserByEmail(any(),anyString())).thenReturn(f.user);
    f.form.putSingle("firstName","Persona"); f.form.putSingle("lastName","Prueba"); f.form.putSingle("terms","true"); f.form.putSingle("privacy","true"); f.action("register");
    verify(f.context.getSession().users(),never()).addUser(any(),anyString());
    verify(f.user,never()).setFirstName(any()); verify(f.context,never()).success();
    assertFalse(f.notes.containsKey("tentu.registration_verified"));
  }
}
