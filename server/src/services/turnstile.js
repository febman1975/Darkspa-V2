const env = require('../config/env');

async function verifyTurnstileToken(token, remoteIp) {
  if (!env.turnstileSecret) {
    return { success: false, reason: 'missing_turnstile_secret' };
  }

  if (!token) {
    return { success: false, reason: 'missing_token' };
  }

  const formData = new URLSearchParams();
  formData.set('secret', env.turnstileSecret);
  formData.set('response', token);
  if (remoteIp) formData.set('remoteip', remoteIp);

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData
  });

  const payload = await response.json();
  return {
    success: Boolean(payload.success),
    reason: Array.isArray(payload['error-codes']) ? payload['error-codes'].join(',') : ''
  };
}

module.exports = {
  verifyTurnstileToken
};
