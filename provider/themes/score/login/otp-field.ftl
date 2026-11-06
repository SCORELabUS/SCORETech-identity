<#macro field name="code" label="Sign-in code">
<label for="${name}">${label}</label>
<input class="tp-otp-code" id="${name}" name="${name}" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus data-otp-autosubmit aria-label="${label}" aria-describedby="otp-status otp-error" />
<p id="otp-error" role="alert"><#if message?has_content && message.type == "error">${kcSanitize(message.summary)?no_esc}</#if></p>
<p id="otp-status" role="status" aria-live="polite"></p>
<button class="btn-primary" type="submit" data-otp-submit>Continue</button>
</#macro>
