// Submit email and app codes on completion, preserving the app's visual cells.
for (const input of document.querySelectorAll('[data-otp]:not([data-otp="segmented"]) input, input[data-otp-autosubmit]')) {
  const field = input.closest('[data-otp]');
  const cells = field ? field.querySelectorAll('.tp-otp-cells span') : [];
  const form = input.form;
  const button = form.querySelector('[data-otp-submit]');
  let submitted = false;
  if (field) field.classList.add('tp-otp-enhanced');
  const paint = () => {
    input.value = input.value.replace(/[^0-9]/g, '').slice(0, 6);
    const activeIndex = Math.min(input.value.length, cells.length - 1);
    cells.forEach((cell, index) => {
      cell.textContent = input.value[index] || '';
      cell.toggleAttribute('data-active', index === activeIndex);
    });
    if (input.value.length === 6 && !submitted) form.requestSubmit(button);
  };
  input.addEventListener('input', paint);
  input.addEventListener('change', paint);
  form.addEventListener('submit', (event) => {
    if (submitted) { event.preventDefault(); return; }
    if (!form.checkValidity()) return;
    submitted = true;
    if (button) button.disabled = true;
    const status = document.getElementById('otp-status');
    if (status) status.textContent = 'Verifying…';
    form.setAttribute('aria-busy', 'true');
  });
  paint();
}

const resend = document.querySelector('[data-otp-resend]');
const countdown = document.querySelector('[data-otp-resend-countdown]');
if (resend instanceof HTMLButtonElement && countdown) {
  let seconds = Number(resend.dataset.cooldownSeconds) || 60;
  resend.disabled = true;
  const renderCountdown = () => {
    if (seconds <= 0) {
      resend.disabled = false;
      countdown.textContent = '';
      return;
    }
    countdown.textContent = `You can request another code in ${seconds} s.`;
    seconds -= 1;
    window.setTimeout(renderCountdown, 1000);
  };
  renderCountdown();
}
