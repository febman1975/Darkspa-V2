const env = require('../config/env');
const { lookupGeo } = require('./geoLookup');

function safe(value, fallback = 'Unknown') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function yesNoEmoji(value, yes = '✅ Yes', no = '❌ No') {
  return value ? yes : no;
}

function truncate(text, max = 3800) {
  const content = String(text || '');
  if (content.length <= max) return content;
  return `${content.slice(0, max - 3)}...`;
}

function formatPlugins(plugins) {
  if (!Array.isArray(plugins) || plugins.length === 0) return 'Unknown';
  const names = plugins.map((item) => String(item || '').trim()).filter(Boolean);
  if (names.length === 0) return 'Unknown';
  return names.slice(0, 8).join(', ');
}

function formatMessage(payload) {
  const now = new Date();
  const ip = safe(payload.ip);
  const meta = payload.clientMeta && typeof payload.clientMeta === 'object' ? payload.clientMeta : {};
  const page = meta.page && typeof meta.page === 'object' ? meta.page : {};
  const screen = meta.screen && typeof meta.screen === 'object' ? meta.screen : {};
  const connection = meta.connection && typeof meta.connection === 'object' ? meta.connection : {};
  const performance = meta.performance && typeof meta.performance === 'object' ? meta.performance : {};
  const memory = meta.memory && typeof meta.memory === 'object' ? meta.memory : {};
  const battery = meta.battery && typeof meta.battery === 'object' ? meta.battery : {};
  const device = meta.device && typeof meta.device === 'object' ? meta.device : {};
  const geo = payload.geo || {};
  const geoRegion = safe(geo.state || geo.region);
  const geoCountry = safe(geo.country || payload.country);
  const geoCountryCode = safe(geo.countryCode || payload.countryCode || payload.country);

  const lines = [
    'New Visitor Analytics',
    '',
    '📍 Location & Network',
    `- IP Address: ${ip}`,
    `- Location: ${safe(geo.city)}, ${geoRegion}`,
    `- Country: ${geoCountry} (${geoCountryCode})`,
    `- Coordinates: ${safe(geo.latitude)}, ${safe(geo.longitude)}`,
    `- ISP: ${safe(geo.isp)}`,
    `- Organization: ${safe(geo.org)}`,
    `- ASN: ${safe(geo.asn)}`,
    `- Timezone: ${safe(geo.timezone)}`,
    '',
    '🌐 Browser & System',
    `- Browser: ${safe(meta.browser)}`,
    `- Platform: ${safe(meta.platform)}`,
    `- Languages: ${Array.isArray(meta.languages) && meta.languages.length ? meta.languages.join(', ') : 'Unknown'}`,
    `- Online Status: ${meta.online ? 'Online' : 'Offline'}`,
    `- Cookies: ${yesNoEmoji(meta.cookiesEnabled, '✅ Enabled', '❌ Disabled')}`,
    `- Do Not Track: ${safe(meta.doNotTrack, 'Not set')}`,
    `- Java: ${yesNoEmoji(meta.javaEnabled, '✅ Enabled', '❌ Disabled')}`,
    '',
    '📱 Device Information',
    `- Device Type: ${safe(device.type || payload.deviceType)}`,
    `- Mobile: ${yesNoEmoji(device.mobile, '📱 Yes', '💻 No')} | Tablet: ${yesNoEmoji(device.tablet, '✅ Yes', '❌ No')}`,
    `- Screen: ${safe(screen.width)}x${safe(screen.height)}`,
    `- Available: ${safe(screen.availWidth)}x${safe(screen.availHeight)}`,
    `- Viewport: ${safe(screen.viewportWidth)}x${safe(screen.viewportHeight)}`,
    `- Color Depth: ${safe(screen.colorDepth)}-bit`,
    `- Pixel Ratio: ${safe(screen.pixelRatio)}`,
    `- Touch: ${yesNoEmoji(device.touch, '✅ Yes', '❌ No')} (Max: ${safe(device.maxTouchPoints, '0')})`,
    `- Orientation: ${safe(screen.orientation)}`,
    '',
    '📄 Page Information',
    `- URL: ${safe(page.url)}`,
    `- Title: ${safe(page.title)}`,
    `- Protocol: ${safe(page.protocol)}`,
    `- Referrer: ${safe(page.referrer)}`,
    `- Origin: ${safe(page.origin)}`,
    '',
    '🌐 Network & Connection',
    `- Connection: ${safe(connection.type)}`,
    `- Speed Type: ${safe(connection.effectiveType)}`,
    `- Download Speed: ${safe(connection.downlink)} Mbps`,
    `- Latency: ${safe(connection.rtt)} ms`,
    '',
    '⚡️ Performance',
    `- Page Load: ${safe(performance.pageLoad)}`,
    `- DOM Ready: ${safe(performance.domReady)}`,
    `- First Paint: ${safe(performance.firstPaint)}`,
    '',
    '🔧 Technical Details',
    `- CPU Cores: ${safe(meta.hardwareConcurrency)}`,
    `- Memory: Used: ${safe(memory.usedJSHeapSize)}MB, Total: ${safe(memory.totalJSHeapSize)}MB, Limit: ${safe(memory.jsHeapSizeLimit)}MB`,
    `- Battery: Level: ${safe(battery.level)}, Charging: ${safe(battery.charging)}`,
    `- Plugins: ${formatPlugins(meta.plugins)}`,
    '',
    '⏱️ Session Information',
    `- Session ID: ${safe(payload.sessionId)}`,
    `- Visit Time: ${safe(meta.visitTime, now.toLocaleString())}`,
    `- Server Time: ${now.toLocaleString()}`,
    '',
    '🖥️ Server Details',
    `- Server IP: ${ip}`,
    `- Host: ${safe(payload.host)}`,
    `- CF Ray: ${safe(payload.cfRay, 'Not Cloudflare')}`,
    `- Accept-Language: ${safe(payload.acceptLanguage)}`,
    `- Accept-Encoding: ${safe(payload.acceptEncoding)}`,
    '',
    '🔍 User Agent',
    safe(payload.userAgent)
  ];

  return truncate(lines.join('\n'));
}

function resolveTelegramConfig(payload) {
  const profileSettings = payload?.profileSettings && typeof payload.profileSettings === 'object'
    ? payload.profileSettings
    : {};

  const enabled = profileSettings.telegramNotifyEnabled ?? env.telegramNotifyEveryVisit;
  const botToken = String(profileSettings.telegramBotToken || env.telegramBotToken || '').trim();
  const chatId = String(profileSettings.telegramChatId || env.telegramChatId || '').trim();
  const modeInput = String(profileSettings.telegramNotifyMode || 'both').trim().toLowerCase();
  const mode = ['both', 'allow', 'block', 'challenge', 'risky'].includes(modeInput) ? modeInput : 'both';

  return { enabled: Boolean(enabled), botToken, chatId, mode };
}

function shouldNotifyForAction(mode, action) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (!normalizedAction) return true;
  if (mode === 'both') return ['allow', 'challenge', 'block'].includes(normalizedAction);
  if (mode === 'risky') return ['challenge', 'block'].includes(normalizedAction);
  if (mode === 'block') return ['challenge', 'block'].includes(normalizedAction);
  return normalizedAction === mode;
}

async function sendTelegramText(text, botToken, chatId) {
  if (!botToken || !chatId) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      }),
      signal: controller.signal
    });

    if (response.ok) return true;
    const reason = await response.text();
    console.warn('[telegram] sendMessage failed', { status: response.status, reason: String(reason || '').slice(0, 240) });
    return false;
  } catch (error) {
    console.warn('[telegram] sendMessage error', { message: error?.message || String(error) });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function notifyVisitorToTelegram(payload) {
  const config = resolveTelegramConfig(payload);
  if (!config.enabled) return;
  if (!config.botToken || !config.chatId) return;
  if (!shouldNotifyForAction(config.mode, payload?.action)) return;

  const incomingGeo = payload?.geo && typeof payload.geo === 'object' ? payload.geo : null;
  const lookedUpGeo = await lookupGeo(payload.ip);
  const geo = {
    ...(lookedUpGeo || {}),
    ...(incomingGeo || {})
  };
  const text = formatMessage({ ...payload, geo });
  try {
    const sent = await sendTelegramText(text, config.botToken, config.chatId);
    if (!sent) {
      const fallbackText = truncate(
        [
          'New Visitor',
          `Action: ${safe(payload?.action)}`,
          `IP: ${safe(payload?.ip)}`,
          `Host: ${safe(payload?.host)}`,
          `Country: ${safe(geo?.country || geo?.countryName || payload?.country)}`,
          `UA: ${safe(payload?.userAgent)}`
        ].join('\n'),
        900
      );
      await sendTelegramText(fallbackText, config.botToken, config.chatId);
    }
  } catch (_error) {
  }
}

module.exports = {
  notifyVisitorToTelegram
};
