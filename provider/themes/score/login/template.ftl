<#import "theme-resources.ftl" as themeResourceTags>
<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html class="tp-auth-root ${properties.kcHtmlClass!}" lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <#-- Keycloak overrides the response Referrer-Policy; scope the form policy to recovery pages. -->
    <#if recoveryMode!false><meta name="referrer" content="same-origin"></#if>
    <title>${msg("loginTitle", realm.displayName!realm.name)}</title>
    <#if properties.stylesCommon?has_content>
        <#list properties.stylesCommon?split(' ') as style>
            <link href="${url.resourcesCommonPath}/${style}" rel="stylesheet">
        </#list>
    </#if>
    <#if properties.styles?has_content>
        <#list properties.styles?split(' ') as style>
            <link href="${url.resourcesPath}/${style}?v=${properties.tentuThemeVersion!'0'}" rel="stylesheet">
        </#list>
    </#if>
    <#if themeResources?? && themeResources.scripts?has_content>
        <@themeResourceTags.renderScripts themeResources.scripts url.resourcesPath "text/javascript" />
    <#elseif properties.scripts?has_content>
        <#list properties.scripts?split(' ') as script><script src="${url.resourcesPath}/${script}"></script></#list>
    </#if>
    <script type="importmap">{"imports":{"rfc4648":"${url.resourcesCommonPath}/vendor/rfc4648/rfc4648.js"}}</script>
    <script src="${url.resourcesPath}/js/otp.js?v=${properties.tentuThemeVersion!'0'}" defer></script>
    <#if !(recoveryMode!false)>
    <script type="module">
      <#outputformat "JavaScript">
      import { startSessionPolling, checkAuthSession } from ${(url.resourcesPath + "/js/authChecker.js")?c};
      startSessionPolling(${url.ssoLoginInOtherTabsUrl?c});
      <#if authenticationSession??>checkAuthSession(${authenticationSession.authSessionIdHash?c});</#if>
      </#outputformat>
    </script>
    </#if>
    <#if scripts??>
        <#list scripts as script>
            <script src="${script}" type="text/javascript"></script>
        </#list>
    </#if>
</head>
<body class="tp-auth-page ${bodyClass}">
    <main class="tp-auth-shell">
        <section class="tp-auth-brand" aria-label="SCORETech Identity">
            <div class="tp-wordmark" aria-label="SCORETech Identity">
                <span>SCORETech</span><small>Identity</small>
            </div>
            <div class="tp-brand-copy">
                <p class="tp-kicker">SCORETech Identity</p>
                <h1>A shared identity<br>for your research.</h1>
                <p class="tp-brand-description">Access your SCORE services securely and manage your account in one place.</p>
            </div>
            <div class="tp-brand-footer"><p>Smart Computer Systems<br>Research and Engineering</p><nav aria-label="Legal documents"><a class="cursor-pointer" href="/identity/legal/terms" target="_blank" rel="noopener noreferrer">Terms</a> · <a class="cursor-pointer" href="/identity/legal/privacy" target="_blank" rel="noopener noreferrer">Privacy</a></nav></div>
        </section>
        <section class="tp-auth-panel" aria-labelledby="tp-auth-title">
            <div class="tp-auth-panel-inner">
                <div class="tp-auth-heading">
                    <p class="tp-kicker">SCORETech Identity</p>
                    <h2 id="tp-auth-title"><#nested "header"></h2>
                    <#if displayRequiredFields>
                        <p class="tp-required-note"><span aria-hidden="true">*</span> ${msg("requiredFields")}</p>
                    </#if>
                </div>
                <#if displayMessage && message?has_content>
                    <div class="tp-alert tp-alert-${message.type}" role="alert">
                        <span class="tp-alert-symbol" aria-hidden="true"><#if message.type = 'success'>✓<#elseif message.type = 'warning'>!<#else>×</#if></span>
                        <span>${kcSanitize(message.summary)?no_esc}</span>
                    </div>
                </#if>
                <#if recoveryMode!false><p class="tp-auth-copy" role="status">Set up your new sign-in method. You will then need to sign in again.</p></#if>
                <div id="kc-content">
                    <div id="kc-content-wrapper">
                        <#nested "form">
                    </div>
                </div>
                <#if (allowOtherMethods!false) || (showSignInRestart!false)>
                    <div class="tp-alternate-form tp-secondary-actions">
                        <#if allowOtherMethods!false>
                            <form action="${url.loginAction}" method="post">
                                <input type="hidden" name="currentMethod" value="${selectedMethod!''}" />
                                <button class="tp-alternate-button" type="submit" name="stage" value="methods">Use another sign-in method</button>
                            </form>
                        </#if>
                        <#if showSignInRestart!false>
                            <a class="tp-alternate-button tp-restart-sign-in" href="${url.loginRestartFlowUrl}">${msg("scoreBackToSignIn")}</a>
                        </#if>
                    </div>
                </#if>
                <#if displayInfo>
                    <aside id="kc-info" class="tp-auth-info">
                        <#nested "info">
                    </aside>
                </#if>
            </div>
        </section>
    </main>
</body>
</html>
</#macro>
