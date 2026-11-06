<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
  <#if section = "header">Recover your access
  <#elseif section = "form">
    <#if recoveryPhase = "start">
      <p>This link lets you set up a new sign-in method. Continue only if you requested help from SCORETech Identity support.</p>
      <form id="recovery-start" action="${recoveryBase}/claim" method="post">
        <input type="hidden" id="recovery-token" name="token" value="">
        <button id="recovery-continue" class="btn-primary" type="submit" disabled>Continue</button>
      </form>
      <p id="recovery-invalid" hidden>The link is incomplete. Ask support to send it again.</p>
      <script src="${url.resourcesPath}/js/recovery.js" defer></script>
    <#elseif recoveryPhase = "choose">
      <p>Choose how to sign in to your account. This temporary session can only register a new credential.</p>
      <form action="${recoveryBase}/choose" method="post">
        <input type="hidden" name="csrf" value="${recoveryCsrf}">
        <button class="btn-primary" type="submit" name="method" value="tentu-register-passkey">Set up a passkey</button>
        <button class="tp-alternate-button" type="submit" name="method" value="CONFIGURE_TOTP">Set up authenticator app</button>
      </form>
    <#elseif recoveryPhase = "completed">
      <p>Your new sign-in method is ready. This link can no longer be used and previous sessions have been ended.</p>
      <p>Sign in to your SCORETech Identity account using your new method.</p>
      <#if recoveryPortal?has_content><a class="btn-primary" href="${recoveryPortal}">Go to your account and sign in</a></#if>
    <#elseif recoveryPhase = "unavailable">
      <p>Recovery is unavailable. This link may have expired, been revoked or already been used. Contact support to continue.</p>
    <#else>
      <p>The attempt limit has been reached. Contact support for a new link.</p>
    </#if>
  </#if>
</@layout.registrationLayout>
