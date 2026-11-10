<#import "template.ftl" as layout>
<@layout.registrationLayout; section>
  <#if section = "header">Complete your account
  <#elseif section = "form">
    <form class="tp-auth-flow tp-registration" action="${url.loginAction}" method="post">
      <p class="tp-auth-copy">Before you continue to SCORETech Identity, review and accept our terms and privacy policy.</p>
      <fieldset class="tp-consents">
        <legend>Before you continue</legend>
        <div class="tp-consent">
          <input id="terms" name="terms" type="checkbox" value="true" required class="cursor-pointer" />
          <label for="terms">I accept the <a href="${termsDocumentUrl}" target="_blank" rel="noopener noreferrer">terms of use</a>.</label>
        </div>
        <div class="tp-consent">
          <input id="privacy" name="privacy" type="checkbox" value="true" required class="cursor-pointer" />
          <label for="privacy">I accept the <a href="${privacyDocumentUrl}" target="_blank" rel="noopener noreferrer">privacy policy</a>.</label>
        </div>
      </fieldset>
      <button class="btn-primary cursor-pointer" type="submit">Continue</button>
    </form>
  </#if>
</@layout.registrationLayout>
