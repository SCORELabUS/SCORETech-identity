<#import "template.ftl" as layout>
<@layout.emailLayout>
<h1 style="font-size:26px;font-weight:600;line-height:1.3;margin:0 0 20px;color:#212529;">Your sign-in code</h1>
<p style="margin:0 0 20px;">Enter this code in SCORETech Identity to continue:</p>
<p style="background:#f8f8f9;border:1px solid #d5d9de;border-radius:5px;color:#212529;font-family:'Courier New',monospace;font-size:32px;line-height:1.5;letter-spacing:6px;text-align:center;padding:18px 8px;font-weight:700;">${code}</p>
<p style="margin:20px 0;">This code expires in ${minutes} minutes and can only be used once. <strong>Never share it with anyone.</strong></p>
<p style="color:#5c6269;font-size:13px;margin:0;">If you did not request this sign-in, you can ignore this email.</p>
</@layout.emailLayout>
