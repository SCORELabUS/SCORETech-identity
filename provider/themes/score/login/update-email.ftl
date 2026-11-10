<#import "template.ftl" as layout>
<#import "password-commons.ftl" as passwordCommons>
<#import "user-profile-commons.ftl" as userProfileCommons>
<@layout.registrationLayout displayMessage=messagesPerField.exists('global') displayRequiredFields=true; section>
    <#if section = "header">
        ${msg("updateEmailTitle")}
    <#elseif section = "form">
        <form id="kc-update-email-form" class="${properties.kcFormClass!}" action="${url.loginAction}" method="post">
            <p>Your current address stays active until you verify the new one. Return here to resend or cancel a pending request.</p>
            <@userProfileCommons.userProfileFormFields/>
            <#if tentuEmailPending!false>
            <button class="tp-email-pending-cancel" type="submit" name="tentu-cancel-pending" value="true" formnovalidate>${msg("tentuCancelPendingEmail")}</button>
            </#if>

            <div class="${properties.kcFormGroupClass!}">
                <div id="kc-form-options" class="${properties.kcFormOptionsClass!}">
                    <div class="${properties.kcFormOptionsWrapperClass!}">
                    </div>
                </div>

                <div class="tp-email-session-option">
                    <@passwordCommons.logoutOtherSessions/>
                </div>

                <div id="kc-form-buttons" class="${properties.kcFormButtonsClass!} tp-email-actions">
                    <#if isAppInitiatedAction??>
                        <input class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonLargeClass!} tp-email-submit" type="submit" value="${msg("doSubmit")}" />
                        <button class="${properties.kcButtonClass!} ${properties.kcButtonDefaultClass!} ${properties.kcButtonLargeClass!} tp-email-cancel" type="submit" name="cancel-aia" value="true" formnovalidate>${msg("doCancel")}</button>
                    <#else>
                        <input class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!} tp-email-submit" type="submit" value="${msg("doSubmit")}" />
                    </#if>
                </div>
            </div>
        </form>
    </#if>
</@layout.registrationLayout>
