<#import "template.ftl" as layout>
<@layout.emailLayout>
    <h1 style="font-size:30px;line-height:1.15;margin:0 0 18px;">${msg("executeActionsTitle")}</h1>
    ${kcSanitize(msg("executeActionsBodyHtml",link,linkExpiration,realmName,linkExpirationFormatter(linkExpiration)))?no_esc}
    <p style="margin:30px 0 0;"><a href="${link}" style="background:#12a85a;border-radius:8px;color:#ffffff;display:inline-block;font-weight:700;padding:13px 22px;text-decoration:none;">${msg("executeActionsButton")}</a></p>
    <p style="color:#766e6b;font-size:13px;margin:26px 0 0;">${msg("emailIgnoreMessage")}</p>
</@layout.emailLayout>
