package es.tentuplaza.identity.emailotp;

import jakarta.ws.rs.BadRequestException;
import java.io.IOException;
import java.net.URI;
import java.time.LocalDate;
import java.util.*;
import org.keycloak.models.ClientModel;
import org.keycloak.models.ClientSessionContext;
import org.keycloak.models.UserModel;
import org.keycloak.representations.AddressClaimSet;
import org.keycloak.representations.IDToken;
import org.keycloak.util.JsonSerialization;

/** The application policy selects public claim names, never native attributes or a raw profile. */
final class ApplicationUserClaims {
  static final String ATTRIBUTE = "scoretech.shared-user-fields";
  static final String LEGACY_DISPLAY_NAME = "scoretech.shared-display-name";
  static final Set<String> FIELDS = Set.of("email", "preferred_username", "name", "given_name", "family_name",
      "display_name", "phone_number", "birthdate", "bio", "city", "country", "avatar", "linkedin", "instagram", "facebook", "x");

  private static final Set<String> PROTOCOL_CLAIMS = Set.of("scope", "realm_access", "resource_access", "authorization",
      "tentu_auth_method", "tentu_admin_verified", "tentu_step_up");
  private static final Map<String, Set<String>> SOCIAL_HOSTS = Map.of(
      "linkedin", Set.of("linkedin.com", "www.linkedin.com"), "instagram", Set.of("instagram.com", "www.instagram.com"),
      "facebook", Set.of("facebook.com", "www.facebook.com"), "x", Set.of("x.com", "www.x.com", "twitter.com", "www.twitter.com"));
  private static final Set<String> PRESETS = Set.of("owl", "fox", "octopus", "robot");
  private static final Set<String> ICONS = Set.of("spark", "rocket", "heart", "leaf", "star",
      "avatar-1", "avatar-2", "avatar-3", "avatar-4", "avatar-6", "avatar-7", "avatar-8", "avatar-9", "avatar-10");
  private static final Set<String> COLORS = Set.of("graphite", "tentu", "stone", "lime", "paper", "charcoal",
      "cyan", "pink", "purple", "orange", "black", "white");

  private ApplicationUserClaims() {}

  static List<String> validate(Object value) {
    if (!(value instanceof List<?> entries) || entries.size() > FIELDS.size())
      throw new BadRequestException("Choose valid user fields for this application.");
    var fields = new TreeSet<String>();
    for (Object entry : entries) {
      if (!(entry instanceof String field) || !FIELDS.contains(field) || !fields.add(field))
        throw new BadRequestException("Choose unique user fields from the supported list.");
    }
    return List.copyOf(fields);
  }

  // Absent preserves existing applications' OIDC behavior. A malformed explicit policy shares nothing.
  static List<String> configured(ClientModel client) {
    String raw = client.getAttribute(ATTRIBUTE);
    if (raw == null) return null;
    try {
      return validate(JsonSerialization.readValue(raw, List.class));
    } catch (IOException | BadRequestException error) {
      return List.of();
    }
  }

  static void apply(IDToken token, UserModel user, ClientSessionContext context, boolean shareProfile, boolean idToken) {
    var clientSession = context == null ? null : context.getClientSession();
    var client = clientSession == null ? null : clientSession.getClient();
    if (client == null || user.getServiceAccountClientLink() != null) return;
    var selected = configured(client);
    if (selected == null) {
      if (idToken && "true".equals(client.getAttribute(LEGACY_DISPLAY_NAME)) && scope(context, "profile")) {
        token.getOtherClaims().put("scoretech_display_name",
            Objects.toString(text(attributes(user, "scoreProfile").get("displayName"), 100), ""));
      }
      return;
    }

    // Explicit policies govern all channels, including claims contributed by realm scopes.
    // Keep authorization and protocol data, then project the chosen profile on ID tokens and UserInfo.
    clearProfile(token);
    if (!shareProfile || selected.isEmpty()) return;
    if (selected.contains("email") && scope(context, "email")) {
      String email = text(user.getEmail(), 254);
      if (email != null) {
        token.setEmail(email);
        token.setEmailVerified(user.isEmailVerified());
      }
    }
    if (!scope(context, "profile")) return;

    String first = text(user.getFirstName(), 100);
    String last = text(user.getLastName(), 100);
    if (selected.contains("name"))
      token.setName(text(String.join(" ", Objects.toString(first, ""), Objects.toString(last, "")), 201));
    if (selected.contains("given_name")) token.setGivenName(first);
    if (selected.contains("family_name")) token.setFamilyName(last);
    if (selected.contains("preferred_username")) {
      String username = text(user.getUsername(), 254);
      // SCORE logins can use the email address as the native username. Keep the domain private here.
      if (username != null) token.setPreferredUsername(username.split("@", 2)[0]);
    }
    if (selected.contains("phone_number")) {
      String phone = text(user.getFirstAttribute("tentuPhone"), 16);
      if (phone != null && phone.matches("[+]?[1-9][0-9]{6,14}")) token.setPhoneNumber(phone);
    }

    var profile = attributes(user, "scoreProfile");
    if (selected.contains("display_name"))
      token.getOtherClaims().put("scoretech_display_name", Objects.toString(text(profile.get("displayName"), 100), ""));
    if (selected.contains("birthdate")) token.setBirthdate(birthdate(profile.get("dateOfBirth")));
    if (selected.contains("bio")) claim(token, "scoretech_bio", text(profile.get("bio"), 200));
    if (selected.contains("city")) claim(token, "scoretech_city", text(profile.get("city"), 100));
    if (selected.contains("country")) claim(token, "scoretech_country", text(profile.get("country"), 100));
    if (selected.contains("avatar")) claim(token, "scoretech_avatar", avatar(attributes(user, "tentuAvatar")));

    var links = new LinkedHashMap<String, String>();
    if (selected.stream().anyMatch(SOCIAL_HOSTS::containsKey)) {
      var social = attributes(user, "scoreSocialLinks");
      for (String field : selected) {
        if (!SOCIAL_HOSTS.containsKey(field)) continue;
        String link = socialLink(social.get(field), SOCIAL_HOSTS.get(field));
        if (link != null) links.put(field, link);
      }
    }
    if (!links.isEmpty()) claim(token, "scoretech_social_links", links);
  }

  private static boolean scope(ClientSessionContext context, String name) {
    return context.getClientScopesStream().anyMatch(scope -> name.equals(scope.getName()));
  }

  private static void clearProfile(IDToken token) {
    token.getOtherClaims().keySet().retainAll(PROTOCOL_CLAIMS);
    token.setName(null); token.setGivenName(null); token.setFamilyName(null); token.setMiddleName(null);
    token.setNickName(null); token.setPreferredUsername(null); token.setProfile(null); token.setPicture(null);
    token.setWebsite(null); token.setEmail(null); token.setEmailVerified(null); token.setGender(null);
    token.setBirthdate(null); token.setZoneinfo(null); token.setLocale(null); token.setPhoneNumber(null);
    token.setPhoneNumberVerified(null); token.setAddress((AddressClaimSet) null);
    token.setUpdatedAt(null); token.setClaimsLocales(null);
  }

  private static void claim(IDToken token, String name, Object value) {
    if (value != null) token.getOtherClaims().put(name, value);
  }

  private static String text(Object value, int limit) {
    if (!(value instanceof String raw)) return null;
    String trimmed = raw.strip();
    return !trimmed.isEmpty() && trimmed.length() <= limit ? trimmed : null;
  }

  private static Map<?, ?> attributes(UserModel user, String key) {
    String raw = user.getFirstAttribute(key);
    if (raw == null || raw.length() > 4096) return Map.of();
    try {
      var value = JsonSerialization.readValue(raw, Map.class);
      return value != null ? value : Map.of();
    } catch (IOException ignored) {
      return Map.of();
    }
  }

  private static String birthdate(Object raw) {
    String value = text(raw, 10);
    if (value == null || !value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) return null;
    try {
      var date = LocalDate.parse(value);
      return date.getYear() >= 1900 && !date.isAfter(LocalDate.now()) ? value : null;
    } catch (java.time.DateTimeException ignored) {
      return null;
    }
  }

  private static String socialLink(Object raw, Set<String> hosts) {
    String value = text(raw, 500);
    if (value == null) return null;
    try {
      var url = URI.create(value);
      String host = url.getHost();
      return ("https".equalsIgnoreCase(url.getScheme()) || "http".equalsIgnoreCase(url.getScheme()))
          && host != null && hosts.contains(host.toLowerCase(Locale.ROOT)) && url.getUserInfo() == null ? value : null;
    } catch (IllegalArgumentException ignored) {
      return null;
    }
  }

  private static boolean color(String value) {
    return value != null && (COLORS.contains(value) || value.matches("#[0-9a-fA-F]{6}"));
  }

  private static Map<String, String> avatar(Map<?, ?> source) {
    String kind = text(source.get("kind"), 10);
    String asset = text(source.get("assetId"), 16);
    if ("preset".equals(kind) && asset != null && PRESETS.contains(asset)) return Map.of("kind", kind, "assetId", asset);
    String background = text(source.get("backgroundColor"), 12);
    String foreground = text(source.get("foregroundColor"), 12);
    if (!color(background) || !color(foreground)) return null;
    if ("initials".equals(kind)) return Map.of("kind", kind, "backgroundColor", background, "foregroundColor", foreground);
    if ("icon".equals(kind) && asset != null && ICONS.contains(asset))
      return Map.of("kind", kind, "assetId", asset, "backgroundColor", background, "foregroundColor", foreground);
    return null; // Uploaded photos require a separately authorized media URL.
  }
}
