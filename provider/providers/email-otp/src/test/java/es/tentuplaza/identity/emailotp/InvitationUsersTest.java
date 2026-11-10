package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import org.junit.jupiter.api.Test;
import org.keycloak.models.UserModel;

class InvitationUsersTest {
  InvitationRedemptionEntity redemption() {
    var entry=new InvitationRedemptionEntity(); entry.userId="user-id";
    entry.completedAt=100L; entry.roleNames="student"; entry.catalogueRevision="revision";
    return entry;
  }
  @Test void returnsCurrentEmailWhileKeepingTheUserIdForNavigation() {
    var user=mock(UserModel.class); when(user.getEmail()).thenReturn("ana@example.test");
    var data=InvitationResourceFactory.invitationUser(redemption(),user);
    assertEquals("ana@example.test",data.get("email")); assertEquals("user-id",data.get("id"));
    when(user.getEmail()).thenReturn("nuevo@example.test");
    assertEquals("nuevo@example.test",InvitationResourceFactory.invitationUser(redemption(),user).get("email"));
  }
  @Test void deletedAccountsAndAccountsWithoutEmailKeepTheirRegistrationEvidence() {
    var data=InvitationResourceFactory.invitationUser(redemption(),null);
    assertNull(data.get("email")); assertEquals(100L,data.get("registeredAt"));
    assertNull(InvitationResourceFactory.invitationUser(redemption(),mock(UserModel.class)).get("email"));
  }
}
