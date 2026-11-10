<#import "template.ftl" as layout>
<@layout.registrationLayout; section>
  <#if section = "header">Disconnect ${providerName}
  <#elseif section = "form">
    <form class="tp-auth-flow" action="${url.loginAction}" method="post">
      <p class="tp-auth-copy">You will no longer be able to sign in to this account with ${providerName}. Your profile, roles and other sign-in methods will remain available.</p>
      <div class="tp-identity-actions">
        <button class="tp-text-button cursor-pointer" name="decision" value="cancel" type="submit">Cancel</button>
        <button class="btn-primary cursor-pointer" name="decision" value="disconnect" type="submit">Disconnect</button>
      </div>
    </form>
  </#if>
</@layout.registrationLayout>
