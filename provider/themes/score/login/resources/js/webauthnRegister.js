const fromBase64Url = (value) => {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const toBase64Url = (value) => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

export async function registerByWebAuthn(input) {
  if (!window.PublicKeyCredential) {
    showFailure(input.errmsg);
    return;
  }

  const publicKey = {
    challenge: fromBase64Url(input.challenge),
    rp: { id: input.rpId, name: input.rpEntityName },
    user: {
      id: fromBase64Url(input.userid),
      name: input.username,
      displayName: input.username,
    },
    pubKeyCredParams: (input.signatureAlgorithms.length
      ? input.signatureAlgorithms
      : [-7]
    ).map((alg) => ({ type: "public-key", alg })),
  };

  if (input.attestationConveyancePreference !== "not specified") {
    publicKey.attestation = input.attestationConveyancePreference;
  }

  const authenticatorSelection = {};
  if (input.authenticatorAttachment !== "not specified") {
    authenticatorSelection.authenticatorAttachment = input.authenticatorAttachment;
  }
  if (input.residentKey && input.residentKey !== "not specified") {
    authenticatorSelection.residentKey = input.residentKey;
    authenticatorSelection.requireResidentKey = input.residentKey === "required";
  } else if (input.requireResidentKey !== "not specified") {
    authenticatorSelection.residentKey = input.requireResidentKey === "Yes" ? "required" : "discouraged";
    authenticatorSelection.requireResidentKey = input.requireResidentKey === "Yes";
  }
  if (input.userVerificationRequirement !== "not specified") {
    authenticatorSelection.userVerification = input.userVerificationRequirement;
  }
  if (Object.keys(authenticatorSelection).length) {
    publicKey.authenticatorSelection = authenticatorSelection;
  }
  if (input.createTimeout !== 0) publicKey.timeout = input.createTimeout * 1000;
  if (input.excludeCredentialIds) {
    publicKey.excludeCredentials = input.excludeCredentialIds.split(",").map((id) => ({
      type: "public-key",
      id: fromBase64Url(id),
    }));
  }

  const button = document.getElementById("registerWebAuthn");
  if (button.disabled) return;
  button.disabled = true;
  document.getElementById("webauthn-registration-error").hidden = true;
  let submitted = false;
  try {
    const result = await navigator.credentials.create({ publicKey });
    if (!result) throw new Error("No passkey was created.");
    document.getElementById("clientDataJSON").value = toBase64Url(new Uint8Array(result.response.clientDataJSON));
    document.getElementById("attestationObject").value = toBase64Url(new Uint8Array(result.response.attestationObject));
    document.getElementById("publicKeyCredentialId").value = toBase64Url(new Uint8Array(result.rawId));
    if (typeof result.response.getTransports === "function") {
      const transports = result.response.getTransports();
      if (transports) document.getElementById("transports").value = transports.join();
    }
    if (result.authenticatorAttachment) {
      document.getElementById("authenticatorAttachment").value = result.authenticatorAttachment;
    }
    document.getElementById("authenticatorLabel").value = input.initLabel;
    document.getElementById("register").requestSubmit();
    submitted = true;
  } catch (error) {
    const message = error.name === "InvalidStateError" ? input.duplicateError
      : error.name === "NotAllowedError" || error.name === "AbortError" ? input.cancelledError
      : input.genericError;
    showFailure(message);
  } finally {
    if (!submitted) button.disabled = false;
  }
}

function showFailure(message) {
  const alert = document.getElementById("webauthn-registration-error");
  alert.textContent = message;
  alert.hidden = false;
}
