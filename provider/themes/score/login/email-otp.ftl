<#import "template.ftl" as layout>
<#import "otp-field.ftl" as otp>
<@layout.registrationLayout displayMessage=(stage != "verify"); section>
  <#if section = "header"><#if stage = "verify">Check your email<#elseif stage = "methods">Choose how to sign in<#elseif stage = "register">Create your SCORETech Identity account<#else>Sign in to SCORETech Identity</#if>
  <#elseif section = "form">
    <#if stage = "verify">
      <form id="kc-email-otp-form" class="tp-auth-flow" action="${url.loginAction}" method="post">
        <input type="hidden" name="stage" value="verify" />
        <p class="tp-auth-copy">We sent a sign-in code to <strong>${email}</strong>. Enter it to continue.</p>
        <@otp.field label="Verification code" />
      </form>
      <div class="tp-resend-copy">
        <p>Cannot find the email? Check your spam folder.</p>
        <form class="tp-inline-form" action="${url.loginAction}" method="post"><button class="tp-inline-action" name="stage" value="resend" data-otp-resend data-cooldown-seconds="${otpCooldownSeconds!60}">Resend code</button><span data-otp-resend-countdown aria-live="polite"></span></form>
      </div>
    <#elseif stage = "methods">
      <p class="tp-auth-copy">Choose a sign-in method configured for your account.</p>
      <form class="tp-method-list" action="${url.loginAction}" method="post">
        <input type="hidden" name="stage" value="select" />
        <#if hasPasskey><button class="tp-method-choice tp-method-choice-primary" name="method" value="passkey"><span class="tp-choice-icon" aria-hidden="true">⌁</span><span><strong>Passkey</strong><small>Use your device, fingerprint or face</small></span><span class="tp-choice-arrow" aria-hidden="true">→</span></button></#if>
        <#if hasTotp><button class="tp-method-choice" name="method" value="totp"><span class="tp-choice-icon tp-choice-icon-code" aria-hidden="true">···</span><span><strong>Authenticator app</strong><small>Enter the six-digit code</small></span><span class="tp-choice-arrow" aria-hidden="true">→</span></button></#if>
        <#if hasEmail><button class="tp-method-choice" name="method" value="email"><span class="tp-choice-icon" aria-hidden="true">@</span><span><strong>Email code</strong><small>Receive a verification code by email</small></span><span class="tp-choice-arrow" aria-hidden="true">→</span></button></#if>
        <#if adminPasskey><p class="tp-policy-note">A passkey is required for your administrative account.</p></#if>
      </form>
    <#elseif stage = "register">
      <form id="kc-email-otp-form" class="tp-auth-flow tp-registration" action="${url.loginAction}" method="post">
        <input type="hidden" name="stage" value="register" /><input type="hidden" name="email" value="${email}" />
        <div class="tp-registration-intro">
          <p class="tp-auth-copy">One account for the SCORE ecosystem. Add your name to finish.</p>
          <div class="tp-verified-email"><span aria-hidden="true">✓</span><span><small>Verified email</small><strong>${email}</strong></span></div>
          <p class="tp-required-note"><span aria-hidden="true">*</span> Required field.</p>
        </div>
        <#if showRegistrationPrivacyNotice!false>
        <aside class="tp-privacy-notice" aria-labelledby="privacy-notice-title">
          <span class="tp-privacy-notice-icon" aria-hidden="true">ⓘ</span>
          <div><strong id="privacy-notice-title">Your personal information</strong>
            <p>Read our <a href="${privacyDocumentUrl!'https://score.us.es/privacy-policy/'}" target="_blank" rel="noopener noreferrer">privacy policy<span class="tp-sr-only"> (opens in a new tab)</span></a> to learn how we handle your personal information.</p>
          </div>
        </aside>
        </#if>
        <div class="tp-registration-grid">
          <div class="tp-field">
            <label for="firstName">First name <span class="tp-required" aria-hidden="true">*</span></label>
            <input id="firstName" name="firstName" type="text" maxlength="100" autocomplete="given-name" placeholder="Your first name" required autofocus />
          </div>
          <div class="tp-field">
            <label for="lastName">Last name <span class="tp-required" aria-hidden="true">*</span></label>
            <input id="lastName" name="lastName" type="text" maxlength="100" autocomplete="family-name" placeholder="Your last name" required />
          </div>
        </div>
        <fieldset class="tp-consents">
          <legend>Before you continue</legend>
          <div class="tp-consent">
            <input id="terms" name="terms" type="checkbox" value="true" required />
            <label for="terms">I accept the <a href="${termsDocumentUrl!'https://score.us.es/'}" target="_blank" rel="noopener noreferrer">terms of use<span class="tp-sr-only"> (opens in a new tab)</span></a> <span class="tp-required" aria-hidden="true">*</span><small>Required to create your account.</small></label>
          </div>
          <div class="tp-consent">
            <input id="privacy" name="privacy" type="checkbox" value="true" required />
            <label for="privacy">I accept the <a href="${privacyDocumentUrl!'https://score.us.es/privacy-policy/'}" target="_blank" rel="noopener noreferrer">privacy policy<span class="tp-sr-only"> (opens in a new tab)</span></a> <span class="tp-required" aria-hidden="true">*</span><small>Required to create your account.</small></label>
          </div>
        </fieldset>
        <button class="btn-primary tp-registration-submit" type="submit">Create account <span aria-hidden="true">→</span></button>
      </form>
    <#else>
      <#assign hasSocialProviders = social?? && social.providers?has_content>
      <#if hasSocialProviders || (showDiscoverPasskey!false)>
        <div class="tp-social-providers" role="group" aria-label="Sign-in options">
          <#if hasSocialProviders>
            <#list social.providers as provider>
              <#assign isGoogle = provider.alias == "google" || provider.alias?starts_with("google-")>
              <#assign isUs = provider.alias == "us-sso">
              <a class="tp-social-provider cursor-pointer<#if isGoogle> tp-social-google<#elseif isUs> tp-social-us</#if>" id="social-${provider.alias}" href="${provider.loginUrl}">
                <#if isGoogle><img class="tp-provider-icon" src="${url.resourcesPath}/img/google.svg" width="20" height="20" alt="" aria-hidden="true" />
                <#elseif isUs><img class="tp-provider-us-logo" src="${url.resourcesPath}/img/universidad-sevilla.png" alt="" aria-hidden="true" /></#if>
                <span>Continue with ${provider.displayName}</span>
              </a>
            </#list>
          </#if>
          <#if showDiscoverPasskey!false>
            <form action="${url.loginAction}" method="post">
              <button class="tp-social-provider tp-social-passkey cursor-pointer" type="submit" name="stage" value="discover-passkey">
                <svg class="tp-provider-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
                  <path d="M14.5 3a6.5 6.5 0 0 0-6.1 8.7L3 17v4h4l2-2v-2h2l2.4-2.4A6.5 6.5 0 1 0 14.5 3Z" />
                  <path d="M16 8h.01" />
                </svg>
                <span>Continue with a passkey</span>
              </button>
            </form>
          </#if>
        </div>
        <div class="tp-social-divider"><span>or continue with email</span></div>
      </#if>
      <form id="kc-email-otp-form" class="tp-auth-flow" action="${url.loginAction}" method="post">
        <input type="hidden" name="stage" value="identify" />
        <p class="tp-auth-copy">Sign in or create an account with your email address.</p>
        <label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" required autofocus />
        <#if showRememberMe!false><label class="checkbox"><input name="rememberMe" type="checkbox" value="on" <#if rememberMeChecked!false>checked</#if> />Remember me on this device</label></#if>
        <input class="btn-primary" type="submit" value="Continue" />
      </form>
    </#if>
  </#if>
</@layout.registrationLayout>
