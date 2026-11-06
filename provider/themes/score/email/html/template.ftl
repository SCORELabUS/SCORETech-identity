<#macro emailLayout footerText="">
<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${msg("emailTitle", realmName!realm.name)}</title>
</head>
<body style="margin:0;background:#f3f4f5;color:#212529;font-family:'Source Sans Pro',Arial,Helvetica,sans-serif;line-height:1.6;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f5;">
        <tr><td align="center" style="padding:32px 12px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #d5d9de;border-radius:8px;overflow:hidden;">
                <tr><td style="background:#BE1D37;padding:28px;color:#ffffff;">
                    <p style="margin:0;font-family:'Courier New',monospace;font-size:28px;font-weight:700;line-height:1.2;letter-spacing:5px;">SCORETech</p>
                    <p style="margin:8px 0 0;font-size:12px;font-weight:600;letter-spacing:1px;">SCORETech Identity</p>
                </td></tr>
                <tr><td style="padding:32px 28px;"><#nested></td></tr>
                <tr><td style="border-top:1px solid #d5d9de;color:#5c6269;font-size:12px;padding:20px 28px;"><#if footerText?has_content>${footerText}<#else>${msg("emailFooter", realmName!realm.name)}</#if></td></tr>
            </table>
        </td></tr>
    </table>
</body>
</html>
</#macro>
