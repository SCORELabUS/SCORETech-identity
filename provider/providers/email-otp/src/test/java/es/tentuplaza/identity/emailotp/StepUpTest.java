package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.time.Instant;
import java.util.Map;
import jakarta.ws.rs.ForbiddenException;
import jakarta.ws.rs.core.Response;
import org.junit.jupiter.api.Test;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.models.*;
import org.mockito.ArgumentCaptor;

class StepUpTest {
  @Test void challengePermitsOnlyTheVerifiedOriginAndDoesNotMutateRealmHeaders() {
    var context = mock(AuthenticationFlowContext.class, RETURNS_DEEP_STUBS);
    var headers = Map.of("contentSecurityPolicy", "frame-src 'self'; frame-ancestors 'self'; object-src 'none';");
    when(context.getRealm().getBrowserSecurityHeaders()).thenReturn(headers);
    when(context.getAuthenticationSession().getAuthNote("tentu.step-up.origin")).thenReturn("https://admin.example.test");
    var security = mock(org.keycloak.headers.SecurityHeadersProvider.class, RETURNS_DEEP_STUBS);
    var session = context.getSession();
    doReturn(security).when(session).getProvider(org.keycloak.headers.SecurityHeadersProvider.class);
    StepUpResourceFactory.frame(context).challenge(Response.ok("factor").build());
    var response = ArgumentCaptor.forClass(Response.class);
    verify(context).challenge(response.capture());
    assertNull(response.getValue().getHeaderString("X-Frame-Options"));
    assertEquals("frame-src 'self';  object-src 'none';; frame-ancestors 'self' https://admin.example.test;", response.getValue().getHeaderString("Content-Security-Policy"));
    assertEquals("frame-src 'self'; frame-ancestors 'self'; object-src 'none';", headers.get("contentSecurityPolicy"));
  }
  @Test void administrativeProofRequiresSameUserLiveSessionAndPasskey() {
    var context = mock(AuthenticationFlowContext.class, RETURNS_DEEP_STUBS);
    var user = mock(UserModel.class); when(user.getId()).thenReturn("actor"); when(context.getUser()).thenReturn(user);
    var auth = context.getAuthenticationSession();
    when(auth.getAuthNote(StepUpResourceFactory.NOTE)).thenReturn("user:target:credentials");
    when(auth.getAuthNote("tentu.step-up.user")).thenReturn("actor");
    when(auth.getAuthNote("tentu.step-up.session")).thenReturn("original");
    when(auth.getAuthNote("tentu.step-up.expires")).thenReturn(Long.toString(Instant.now().plusSeconds(120).toEpochMilli()));
    assertThrows(ForbiddenException.class, () -> StepUpResourceFactory.complete(context, "email-otp"));
    assertDoesNotThrow(() -> StepUpResourceFactory.complete(context, AuthenticationPolicy.PASSKEY));
    when(user.getId()).thenReturn("other");
    assertThrows(ForbiddenException.class, () -> StepUpResourceFactory.complete(context, AuthenticationPolicy.PASSKEY));
    when(user.getId()).thenReturn("actor"); when(auth.getAuthNote("tentu.step-up.expires")).thenReturn("1");
    assertThrows(ForbiddenException.class, () -> StepUpResourceFactory.complete(context, AuthenticationPolicy.PASSKEY));
  }
  @Test void deactivationTicketUsesOnlyItsOwnSignedAndLivePermission() {
    String scope="user:00000000-0000-4000-8000-000000000001:deactivate";
    String permission="identity:users:deactivate";
    var realm=mock(RealmModel.class);
    var actor=mock(UserModel.class);
    var role=mock(RoleModel.class);
    var entry=mock(RoleModel.class);
    var token=new org.keycloak.representations.AccessToken();
    token.issuedFor("identity-admin-web");
    token.setRealmAccess(new org.keycloak.representations.AccessToken.Access().addRole(permission).addRole("admin-web:staging:access"));
    when(realm.getAttribute(AuthorizationResourceFactory.ACTIVE)).thenReturn("{\"environment\":\"staging\"}");
    when(realm.getRole(permission)).thenReturn(role);
    when(realm.getRole("admin-web:staging:access")).thenReturn(entry);
    when(actor.hasRole(role)).thenReturn(true);
    when(actor.hasRole(entry)).thenReturn(true);
    var auth=new org.keycloak.services.managers.AuthenticationManager.AuthResult(actor,mock(UserSessionModel.class),token,mock(ClientModel.class));
    assertDoesNotThrow(() -> StepUpResourceFactory.authorizeScope(realm,auth,scope));
    assertThrows(ForbiddenException.class, () -> StepUpResourceFactory.authorizeScope(realm,auth,scope.replace(":deactivate",":credentials")));
    when(actor.hasRole(role)).thenReturn(false);
    assertThrows(ForbiddenException.class, () -> StepUpResourceFactory.authorizeScope(realm,auth,scope));
    when(actor.hasRole(role)).thenReturn(true);
    token.getRealmAccess().getRoles().remove(permission);
    assertThrows(ForbiddenException.class, () -> StepUpResourceFactory.authorizeScope(realm,auth,scope));
    token.getRealmAccess().addRole(permission);
    token.getRealmAccess().getRoles().remove("admin-web:staging:access");
    token.getRealmAccess().addRole("admin-web:production:access");
    assertThrows(ForbiddenException.class, () -> StepUpResourceFactory.authorizeScope(realm,auth,scope));
    token.getRealmAccess().addRole("admin-web:staging:access");
    token.issuedFor("identity-account-web");
    assertThrows(ForbiddenException.class, () -> StepUpResourceFactory.authorizeScope(realm,auth,scope));
    assertThrows(jakarta.ws.rs.NotAuthorizedException.class, () -> StepUpResourceFactory.authorizeScope(realm,null,scope));
    assertThrows(jakarta.ws.rs.BadRequestException.class, () -> StepUpResourceFactory.authorizeScope(realm,auth,scope.replace(":deactivate",":unapproved")));
  }
  @Test void deactivationProofRemainsActorBoundFreshAndPasskeyOnly() {
    var context=mock(AuthenticationFlowContext.class,RETURNS_DEEP_STUBS);
    when(context.getUser().getId()).thenReturn("actor");
    var auth=context.getAuthenticationSession();
    when(auth.getAuthNote(StepUpResourceFactory.NOTE)).thenReturn("user:00000000-0000-4000-8000-000000000001:deactivate");
    when(auth.getAuthNote("tentu.step-up.user")).thenReturn("actor");
    when(auth.getAuthNote("tentu.step-up.session")).thenReturn("original");
    when(auth.getAuthNote("tentu.step-up.expires")).thenReturn(Long.toString(Instant.now().plusSeconds(120).toEpochMilli()));
    assertThrows(ForbiddenException.class, () -> StepUpResourceFactory.complete(context,"email-otp"));
    assertDoesNotThrow(() -> StepUpResourceFactory.complete(context,AuthenticationPolicy.PASSKEY));
    when(context.getUser().getId()).thenReturn("target");
    assertThrows(ForbiddenException.class, () -> StepUpResourceFactory.complete(context,AuthenticationPolicy.PASSKEY));
    when(context.getUser().getId()).thenReturn("actor");
    when(auth.getAuthNote("tentu.step-up.expires")).thenReturn("1");
    assertThrows(ForbiddenException.class, () -> StepUpResourceFactory.complete(context,AuthenticationPolicy.PASSKEY));
    when(auth.getAuthNote("tentu.step-up.expires")).thenReturn(Long.toString(Instant.now().plusSeconds(120).toEpochMilli()));
    when(context.getSession().sessions().getUserSession(context.getRealm(),"original")).thenReturn(null);
    assertThrows(ForbiddenException.class, () -> StepUpResourceFactory.complete(context,AuthenticationPolicy.PASSKEY));
  }
  @Test void immediatePopupReplacementIsAllowedButFurtherRequestsAreThrottled() {
    var session = mock(KeycloakSession.class, RETURNS_DEEP_STUBS);
    var occupied = new java.util.HashSet<String>();
    when(session.singleUseObjects().putIfAbsent(anyString(), eq(3L)))
      .thenAnswer(call -> occupied.add(call.getArgument(0)));
    assertTrue(StepUpResourceFactory.allowChallenge(session,"realm","actor"));
    assertTrue(StepUpResourceFactory.allowChallenge(session,"realm","actor"));
    assertFalse(StepUpResourceFactory.allowChallenge(session,"realm","actor"));
    assertTrue(StepUpResourceFactory.allowChallenge(session,"realm","another-actor"));
    occupied.clear();
    assertTrue(StepUpResourceFactory.allowChallenge(session,"realm","actor"));
  }
  @Test void normalLoginKeepsNativeFrameRestrictions() {
    var context = mock(AuthenticationFlowContext.class, RETURNS_DEEP_STUBS);
    assertSame(context, StepUpResourceFactory.frame(context));
    verify(context.getSession(), never()).getProvider(org.keycloak.headers.SecurityHeadersProvider.class);
  }
}
