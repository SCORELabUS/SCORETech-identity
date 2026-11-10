<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
  <#if section = "header">Sign in with your passkey
  <#elseif section = "form">
    <div class="tp-passkey-card">
      <div class="tp-passkey-illustration" aria-hidden="true">
        <img class="tp-passkey-art" src="${url.resourcesPath}/img/passkey-access.svg?v=${properties.tentuThemeVersion!'0'}" alt=""/>
      </div>
      <p class="tp-auth-copy">Opening your passkeys. Confirm your identity with your fingerprint, face or registered security device.</p>
      <#if authenticators?? && shouldDisplayAuthenticators?? && shouldDisplayAuthenticators && authenticators.authenticators?size gt 1>
        <div class="tp-passkey-list"><p>Available passkeys</p><#list authenticators.authenticators as authenticator><div class="tp-passkey-credential">${authenticator.label}</div></#list></div>
      </#if>
      <div id="kc-form-webauthn">
        <form id="webauth" action="${url.loginAction}" method="post">
          <input type="hidden" id="clientDataJSON" name="clientDataJSON"/><input type="hidden" id="authenticatorData" name="authenticatorData"/><input type="hidden" id="signature" name="signature"/><input type="hidden" id="credentialId" name="credentialId"/><input type="hidden" id="userHandle" name="userHandle"/><input type="hidden" id="error" name="error"/>
        </form>
        <#if authenticators??><form id="authn_select"><#list authenticators.authenticators as authenticator><input type="hidden" name="authn_use_chk" value="${authenticator.credentialId}"/></#list></form></#if>
        <p id="passkey-status" class="tp-passkey-status" role="status" aria-live="polite">Waiting for confirmation from your device…</p>
        <button id="retryWebAuthnButton" type="button" class="tp-passkey-button" hidden>Try your passkey again <span aria-hidden="true">↻</span></button>
      </div>
      <p class="tp-passkey-hint">Your browser will open a secure prompt. Your biometric data stays on your device.</p>
    </div>
    <script type="module">
      <#outputformat "JavaScript">
      import { doAuthenticate, returnSuccess } from "${url.resourcesPath}/js/webauthnAuthenticate.js";
      import { startPasskeyPrompt } from "${url.resourcesPath}/js/passkeyPrompt.js?v=${properties.tentuThemeVersion!'0'}";
      const input = { isUserIdentified: ${isUserIdentified}, challenge: ${challenge?c}, userVerification: ${userVerification?c}, rpId: ${rpId?c}, createTimeout: ${createTimeout?c}, errmsg: ${msg("webauthn-unsupported-browser-text")?c} };
      startPasskeyPrompt(input, { authenticate: doAuthenticate, submit: returnSuccess });
      </#outputformat>
    </script>
  </#if>
</@layout.registrationLayout>
