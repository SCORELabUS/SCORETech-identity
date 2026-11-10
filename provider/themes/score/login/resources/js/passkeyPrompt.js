// Wait for the provider document to receive focus before opening the native prompt.
// A modal in the parent application can otherwise leave focus on its Cancel button.
export function startPasskeyPrompt(input, { authenticate, submit }) {
  const status = document.getElementById('passkey-status');
  const retry = document.getElementById('retryWebAuthnButton');
  let running = false;
  let started = false;
  let submitted = false;
  let needsSeparateWindow = false;

  async function requestPasskey() {
    if (running || submitted || needsSeparateWindow) return;
    started = true;
    running = true;
    retry.hidden = true;
    retry.disabled = true;
    status.textContent = 'Waiting for your device to confirm…';
    try {
      if (!window.PublicKeyCredential) {
        status.textContent = input.errmsg;
        return;
      }
      const result = await authenticate(input);
      if (result) {
        // Some browsers omit topOrigin in cross-origin assertions. Keep the
        // server's exact top-origin validation and use a top-level ceremony.
        if (result.response?.clientDataJSON) {
          const data = JSON.parse(new TextDecoder().decode(result.response.clientDataJSON));
          if (data.crossOrigin === true && !data.topOrigin) {
            needsSeparateWindow = true;
            status.textContent = 'Your browser needs a separate window to verify this passkey. Continue in a secure window; your form is preserved.';
            return;
          }
        }
        submitted = true;
        submit(result);
        return;
      }
      status.textContent = 'No passkey was selected. You can try again.';
    } catch (error) {
      status.textContent = error?.name === 'NotAllowedError'
        ? 'The request did not complete. It may have been cancelled or blocked by your browser. Try again.'
        : error?.name === 'AbortError'
          ? 'The request was cancelled. You can try again.'
          : 'Unable to open your passkeys. Try again or use a secure window.';
    } finally {
      running = false;
      retry.disabled = false;
      retry.hidden = submitted || needsSeparateWindow;
      retry.firstChild.textContent = 'Retry with passkey ';
    }
  }

  function startWhenFocused() {
    if (started || document.visibilityState === 'hidden' || !document.hasFocus()) return;
    void requestPasskey();
  }
  retry.hidden = false;
  retry.firstChild.textContent = 'Verify with passkey ';
  status.textContent = 'Preparing your secure passkey request…';
  retry.addEventListener('click', requestPasskey);
  window.addEventListener('focus', startWhenFocused);
  document.addEventListener('visibilitychange', startWhenFocused);
  startWhenFocused();
}
