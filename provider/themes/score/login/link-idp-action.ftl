<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
  <#if section = "header">Connect ${idpDisplayName}
  <#elseif section = "form">
    <form class="tp-auth-flow" action="${url.loginAction}" method="post">
      <p class="tp-auth-copy">Sign in with ${idpDisplayName} to connect it to your current SCORETech Identity account. Your profile, roles and permissions will stay together.</p>
      <div class="tp-identity-actions">
        <button class="tp-text-button cursor-pointer" name="cancel-aia" value="true" type="submit">Cancel</button>
        <button class="btn-primary cursor-pointer" name="continue" value="true" type="submit">Continue</button>
      </div>
    </form>
  </#if>
</@layout.registrationLayout>
