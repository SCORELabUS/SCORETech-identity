// Fragments are never sent to the server or Referer. Visiting the URL does not consume it.
const token = window.location.hash.slice(1);
window.history.replaceState(null, '', window.location.pathname);
if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
  document.getElementById('recovery-token').value = token;
  document.getElementById('recovery-continue').disabled = false;
} else {
  document.getElementById('recovery-invalid').hidden = false;
}
