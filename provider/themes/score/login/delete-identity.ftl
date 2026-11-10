<#import "template.ftl" as layout>
<@layout.registrationLayout; section>
  <#if section = "header">Delete your SCORETech identity
  <#elseif section = "form">
    <form class="tp-auth-flow" action="${url.loginAction}" method="post">
      <p class="tp-auth-copy">This permanently deletes your central profile, connected sign-in providers, roles and sessions. You will lose access to services using this identity.</p>
      <p class="tp-auth-copy">This does not delete SPHERE or SPACE data. Manage your service data, subscriptions and organization ownership in each service first.</p>
      <label class="tp-field" for="identity-delete-confirmation">Type ${confirmationEmail} to confirm
        <input id="identity-delete-confirmation" name="confirmation" type="email" autocomplete="off" required />
      </label>
      <div class="tp-identity-actions">
        <button class="tp-text-button cursor-pointer" name="decision" value="cancel" type="submit" formnovalidate>Cancel</button>
        <button class="btn-primary cursor-pointer" name="decision" value="delete" type="submit">Delete my identity</button>
      </div>
    </form>
  </#if>
</@layout.registrationLayout>
