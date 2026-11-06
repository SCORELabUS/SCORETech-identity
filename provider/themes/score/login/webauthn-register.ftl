<#import "template.ftl" as layout>
<#import "password-commons.ftl" as passwordCommons>

<@layout.registrationLayout; section>
    <#if section = "title">
        title
    <#elseif section = "header">
        <span class="${properties.kcWebAuthnKeyIcon!}"></span>
        ${msg("webauthn-registration-title")}
    <#elseif section = "form">

        <p class="tp-auth-copy">A passkey lets you sign in using your device PIN or verification method.</p>
        <#if administrativeRegistration!false><p role="status">Create a passkey to access administration. We recommend adding a second passkey or a physical security key as a backup.</p></#if>
        <p class="tp-passkey-register-hint">${msg("tentuPasskeyAdditionalHint")}</p>
        <div id="webauthn-registration-error" class="tp-alert tp-alert-error" role="alert" hidden></div>
        <noscript>Enable JavaScript to create your passkey.</noscript>
        <form id="register" class="${properties.kcFormClass!}" action="${url.loginAction}" method="post">
            <div class="${properties.kcFormGroupClass!}">
                <input type="hidden" id="clientDataJSON" name="clientDataJSON"/>
                <input type="hidden" id="attestationObject" name="attestationObject"/>
                <input type="hidden" id="publicKeyCredentialId" name="publicKeyCredentialId"/>
                <input type="hidden" id="authenticatorLabel" name="authenticatorLabel"/>
                <input type="hidden" id="transports" name="transports"/>
                <input type="hidden" id="authenticatorAttachment" name="authenticatorAttachment"/>
                <input type="hidden" id="error" name="error"/>
                <#if !(recoveryMode!false)><@passwordCommons.logoutOtherSessions/></#if>
            </div>
        </form>

        <script type="module">
            <#outputformat "JavaScript">
            import { registerByWebAuthn } from "${url.resourcesPath}/js/webauthnRegister.js?v=${properties.tentuThemeVersion!'0'}";
            const registerButton = document.getElementById('registerWebAuthn');
            registerButton.addEventListener("click", function() {
                const input = {
                    challenge : ${challenge?c},
                    userid : ${userid?c},
                    username : ${username?c},
                    signatureAlgorithms : [<#list signatureAlgorithms as sigAlg>${sigAlg?c},</#list>],
                    rpEntityName : ${rpEntityName?c},
                    rpId : ${rpId?c},
                    attestationConveyancePreference : ${attestationConveyancePreference?c},
                    authenticatorAttachment : ${authenticatorAttachment?c},
                    requireResidentKey : ${requireResidentKey?c},
                    residentKey : ${residentKey?c},
                    userVerificationRequirement : ${userVerificationRequirement?c},
                    createTimeout : ${createTimeout?c},
                    excludeCredentialIds : ${excludeCredentialIds?c},
                    initLabel : ${(defaultPasskeyLabel!msg("webauthn-registration-init-label"))?c},
                    errmsg : ${msg("webauthn-unsupported-browser-text")?c},
                    duplicateError : ${msg("tentuPasskeyDuplicate")?c},
                    cancelledError : ${msg("tentuPasskeyCancelled")?c},
                    genericError : ${msg("tentuPasskeyRegistrationFailed")?c}
                };
                registerByWebAuthn(input);
            });
            </#outputformat>
        </script>

        <div class="tp-confirm-actions">
        <#if !isSetRetry?has_content && isAppInitiatedAction?has_content>
            <form action="${url.loginAction}" class="${properties.kcFormClass!}" id="kc-webauthn-settings-form"
                  method="post">
                <button type="submit"
                        class="${properties.kcButtonClass!} ${properties.kcButtonDefaultClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}"
                        id="cancelWebAuthnAIA" name="cancel-aia" value="true">${msg("doCancel")}
                </button>
            </form>
        </#if>
        <input type="button"
               class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}"
               id="registerWebAuthn" value="${msg("doRegisterSecurityKey")}"/>

        </div>

    </#if>
</@layout.registrationLayout>
