<#import "otp-field.ftl" as otpField>
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('totp'); section>
    <#if section="header">
        Sign in with your authenticator
    <#elseif section="form">
        <form id="kc-otp-login-form" class="${properties.kcFormClass!}"  action="${url.loginAction}"
            method="post">
            <#if otpLogin.userOtpCredentials?size gt 1>
                <div class="${properties.kcFormGroupClass!}">
                    <div class="${properties.kcInputWrapperClass!}">
                        <#list otpLogin.userOtpCredentials as otpCredential>
                            <input id="kc-otp-credential-${otpCredential?index}" class="${properties.kcLoginOTPListInputClass!}" type="radio" name="selectedCredentialId" value="${otpCredential.id}" <#if otpCredential.id == otpLogin.selectedCredentialId>checked="checked"</#if>>
                            <label for="kc-otp-credential-${otpCredential?index}" class="${properties.kcLoginOTPListClass!}" tabindex="${otpCredential?index}">
                                <span class="${properties.kcLoginOTPListItemHeaderClass!}">
                                    <span class="${properties.kcLoginOTPListItemIconBodyClass!}">
                                      <i class="${properties.kcLoginOTPListItemIconClass!}" aria-hidden="true"></i>
                                    </span>
                                    <span class="${properties.kcLoginOTPListItemTitleClass!}">${otpCredential.userLabel}</span>
                                </span>
                            </label>
                        </#list>
                    </div>
                </div>
            </#if>

            <div class="${properties.kcFormGroupClass!}">
                <div class="tp-method-hero tp-method-hero-authenticator" aria-hidden="true"><span class="tp-method-icon">···</span><span class="tp-method-orbit"></span></div>
                <p class="tp-auth-copy">Open your authenticator app and enter its six-digit code.</p>
                <div class="${properties.kcLabelWrapperClass!}"><label for="otp" class="${properties.kcLabelClass!}">Authenticator code</label></div>

            <div class="${properties.kcInputWrapperClass!}">
                <div class="tp-otp" data-otp><input id="otp" name="otp" autocomplete="one-time-code" type="text" class="${properties.kcInputClass!}"
                       autofocus aria-invalid="<#if messagesPerField.existsError('totp')>true</#if>"
                       dir="ltr" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" /><div class="tp-otp-cells" aria-hidden="true"><#list 1..6 as i><span></span></#list></div></div><p id="otp-status" role="status"></p>

                <#if messagesPerField.existsError('totp')>
                    <span id="input-error-otp-code" class="${properties.kcInputErrorMessageClass!}"
                          aria-live="polite">
                        ${kcSanitize(messagesPerField.get('totp'))?no_esc}
                    </span>
                </#if>
            </div>
        </div>

            <div class="${properties.kcFormGroupClass!}">
                <div id="kc-form-options" class="${properties.kcFormOptionsClass!}">
                    <div class="${properties.kcFormOptionsWrapperClass!}">
                    </div>
                </div>

                <div id="kc-form-buttons" class="${properties.kcFormButtonsClass!}">
                    <input
                        class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}"
                        data-otp-submit name="login" id="kc-login" type="submit" value="${msg("doLogIn")}" />
                </div>
            </div>
        </form>
    </#if>
</@layout.registrationLayout>
