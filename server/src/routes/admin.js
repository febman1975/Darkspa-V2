const express = require('express');
const RiskEvent = require('../models/RiskEvent');
const BlockedIp = require('../models/BlockedIp');
const FilterProfile = require('../models/FilterProfile');
const env = require('../config/env');

const router = express.Router();
const EXPORT_BUILD_TAG = 'darkspa-assess-v5-20260302';

const PROFILE_DEFAULTS = {
  filterLevel: 'medium',
  humanRedirectUrl: '',
  botRedirectUrl: '',
  challengeRedirectUrl: '',
  minInteractions: 5,
  minBrowserTimeMs: 2500,
  challengeScore: 35,
  blockScore: 65,
  autoBlockEnabled: true,
  autoBlockThreshold: 3,
  autoBlockWindowMinutes: 15,
  telegramNotifyEnabled: false,
  telegramNotifyMode: 'both',
  telegramBotToken: '',
  telegramChatId: ''
};

function normalizeProfileSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    ...PROFILE_DEFAULTS,
    ...source,
    minInteractions: Math.max(0, Number(source.minInteractions ?? PROFILE_DEFAULTS.minInteractions)),
    minBrowserTimeMs: Math.max(0, Number(source.minBrowserTimeMs ?? PROFILE_DEFAULTS.minBrowserTimeMs)),
    challengeScore: Math.max(1, Number(source.challengeScore ?? PROFILE_DEFAULTS.challengeScore)),
    blockScore: Math.max(1, Number(source.blockScore ?? PROFILE_DEFAULTS.blockScore)),
    autoBlockEnabled: Boolean(source.autoBlockEnabled ?? PROFILE_DEFAULTS.autoBlockEnabled),
    autoBlockThreshold: Math.max(1, Number(source.autoBlockThreshold ?? PROFILE_DEFAULTS.autoBlockThreshold)),
    autoBlockWindowMinutes: Math.max(
      1,
      Number(source.autoBlockWindowMinutes ?? PROFILE_DEFAULTS.autoBlockWindowMinutes)
    ),
    telegramNotifyEnabled: Boolean(source.telegramNotifyEnabled ?? PROFILE_DEFAULTS.telegramNotifyEnabled),
    telegramNotifyMode: ['both', 'allow', 'block'].includes(String(source.telegramNotifyMode || '').toLowerCase())
      ? String(source.telegramNotifyMode).toLowerCase()
      : PROFILE_DEFAULTS.telegramNotifyMode,
    telegramBotToken: String(source.telegramBotToken ?? PROFILE_DEFAULTS.telegramBotToken ?? '').trim(),
    telegramChatId: String(source.telegramChatId ?? PROFILE_DEFAULTS.telegramChatId ?? '').trim()
  };
}

async function ensureInitialProfiles() {
  const count = await FilterProfile.countDocuments();
  if (count > 0) return;

  const documents = Array.from({ length: 7 }, (_value, index) => ({
    profileId: `profile_${index + 1}`,
    name: `Profile ${index + 1}`,
    isActive: index === 0,
    settings: { ...PROFILE_DEFAULTS }
  }));

  await FilterProfile.insertMany(documents);
}

function phpEscape(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function deriveAssessUrl(settings) {
  const publicApiBaseUrl = String(env.publicApiBaseUrl || '').trim();
  if (/^https?:\/\//i.test(publicApiBaseUrl)) {
    return `${publicApiBaseUrl.replace(/\/$/, '')}/api/antibot/assess`;
  }

  const challengeRaw = String(settings?.challengeRedirectUrl || '').trim();
  if (challengeRaw) {
    try {
      const parsed = new URL(challengeRaw);
      parsed.pathname = '/api/antibot/assess';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch (_error) {
    }
  }

  const corsOrigin = String(env.corsOrigin || '').trim();
  if (/^https?:\/\//i.test(corsOrigin)) {
    return `${corsOrigin.replace(/\/$/, '')}/api/antibot/assess`;
  }

  return '/api/antibot/assess';
}

function buildIndexPhp(profile) {
  const settings = normalizeProfileSettings(profile.settings || {});
  const humanUrl = phpEscape(settings.humanRedirectUrl);
  const botUrl = phpEscape(settings.botRedirectUrl);
  const challengeUrl = phpEscape(String(env.permanentChallengeUrl || settings.challengeRedirectUrl || '').trim());
  const assessUrl = phpEscape(deriveAssessUrl(settings));
  const assessResolveIp = phpEscape(env.exportAssessResolveIp);

  return `<?php
$profile_name = '${phpEscape(profile.name)}';
$build_tag = '${EXPORT_BUILD_TAG}';
$human_url = '${humanUrl}';
$bot_url = '${botUrl}';
$challenge_url = '${challengeUrl}';
$assess_url = '${assessUrl}';
$assess_resolve_ip = '${assessResolveIp}';

function darkspa_apply_email_template($url, $email) {
  $base = (string)($url ?? '');
  if ($base === '') return $base;
  $raw = trim((string)$email);
  if ($raw === '') return $base;
  $encoded = rawurlencode($raw);
  return str_replace(
    ['*EMAIL_RAW', '##EMAIL_RAW', '*EMAIL', '##EMAIL', '{{email_raw}}', '{{email}}', '[EMAIL_RAW]', '[EMAIL]'],
    ['*' . $raw, $raw, '*' . $raw, $encoded, $raw, $encoded, $raw, $encoded],
    $base
  );
}

function darkspa_build_challenge_url($challengeUrl, $humanUrl, $botUrl, $email, $origin = '') {
  $base = trim((string)$challengeUrl);
  if ($base === '') return darkspa_apply_email_template((string)$botUrl, $email);

  $pass = darkspa_apply_email_template((string)$humanUrl, $email);
  $fail = darkspa_apply_email_template((string)$botUrl, $email);
  $joiner = (strpos($base, '?') !== false) ? '&' : '?';

  return $base
    . $joiner . 'pass=' . rawurlencode($pass)
    . '&fail=' . rawurlencode($fail)
    . '&origin=' . rawurlencode((string)$origin)
    . '&build=' . rawurlencode('${EXPORT_BUILD_TAG}');
}

function darkspa_redirect_allowed_for_action($action, $redirect) {
  $value = trim((string)$redirect);
  if ($value === '') return false;
  return in_array($action, ['block', 'challenge'], true);
}

function darkspa_get_client_ip() {
  $headers = ['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'];
  foreach ($headers as $key) {
    if (!empty($_SERVER[$key])) {
      $value = trim((string)$_SERVER[$key]);
      if ($key === 'HTTP_X_FORWARDED_FOR') {
        $parts = explode(',', $value);
        $value = trim((string)($parts[0] ?? ''));
      }
      if ($value !== '') return $value;
    }
  }
  return '';
}

function darkspa_redirect_now($url, $buildTag) {
  $target = trim((string)$url);
  if ($target === '') $target = '/';

  if (!headers_sent()) {
    header('X-DarkSpa-Build: ' . (string)$buildTag);
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('Location: ' . $target, true, 302);
    exit;
  }

  $safe = htmlspecialchars($target, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
  echo '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=' . $safe . '"></head><body><script>window.location.replace(' . json_encode($target) . ');</script><noscript><a href="' . $safe . '">Continue</a></noscript></body></html>';
  exit;
}

$scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$host = (string)($_SERVER['HTTP_HOST'] ?? '');
$request_uri = (string)($_SERVER['REQUEST_URI'] ?? '/');
$page_url = $host ? ($scheme . '://' . $host . $request_uri) : $request_uri;
$referrer = (string)($_SERVER['HTTP_REFERER'] ?? '');
$user_agent = (string)($_SERVER['HTTP_USER_AGENT'] ?? '');
$path = parse_url($request_uri, PHP_URL_PATH);
if (!$path) $path = '/';
$client_ip = darkspa_get_client_ip();

$session_cookie_name = 'ds_session';
$session_id = trim((string)($_COOKIE[$session_cookie_name] ?? ''));
if ($session_id === '') {
  $session_id = 'sess_' . bin2hex(random_bytes(16));
  setcookie($session_cookie_name, $session_id, [
    'expires' => time() + (60 * 60 * 24 * 7),
    'path' => '/',
    'secure' => ($scheme === 'https'),
    'httponly' => true,
    'samesite' => 'Lax'
  ]);
}

$fingerprint = hash('sha256', strtolower($host) . '|' . $user_agent . '|' . $client_ip);

$known_email = '';
$email_keys = ['email', 'e', 'recipient', 'to', 'user'];
foreach ($email_keys as $k) {
  $candidate = trim((string)($_GET[$k] ?? ''));
  if ($candidate !== '') {
    $known_email = $candidate;
    break;
  }
}

if ($known_email === '' && empty($_GET['__hash_migrated'])) {
  header('Content-Type: text/html; charset=utf-8');
  echo '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loading</title></head><body><script>(function(){try{var hash=(window.location.hash||""),value=hash.replace(/^#/,"").trim();if(!value)return;value=value.replace(/^mailto:/i,"");var hasAt=value.indexOf("@")>-1;if(!hasAt)return;var url=new URL(window.location.href);if(!url.searchParams.get("email")){url.searchParams.set("email",value);}url.searchParams.set("__hash_migrated","1");url.hash="";window.location.replace(url.toString());}catch(_e){}})();</script></body></html>';
  exit;
}

$payload = [
  'sessionId' => $session_id,
  'fingerprint' => $fingerprint,
  'pageUrl' => $page_url,
  'referrer' => $referrer,
  'path' => $path,
  'source' => 'direct',
  'email' => $known_email,
  'behavior' => [
    'mouseMoves' => 0,
    'clicks' => 0,
    'keydowns' => 0,
    'scrolls' => 0,
    'dwellMs' => 0
  ]
];

$human_target = darkspa_apply_email_template($human_url, $known_email);
$bot_target = darkspa_apply_email_template($bot_url, $known_email);
$page_origin = $host ? ($scheme . '://' . $host) : '';
$challenge_target = darkspa_build_challenge_url($challenge_url, $human_url, $bot_url, $known_email, $page_origin);
$target = $challenge_target;

if (!empty($assess_url)) {
  $ch = curl_init($assess_url);
  if ($ch) {
    if (!empty($assess_resolve_ip)) {
      $assess_host = parse_url($assess_url, PHP_URL_HOST);
      if (!empty($assess_host)) {
        curl_setopt($ch, CURLOPT_RESOLVE, [
          $assess_host . ':443:' . $assess_resolve_ip
        ]);
      }
    }

    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
      'Content-Type: application/json',
      'Accept: application/json',
      'CF-Connecting-IP: ' . $client_ip,
      'X-Forwarded-For: ' . $client_ip,
      'User-Agent: ' . $user_agent
    ]);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 4);
    curl_setopt($ch, CURLOPT_TIMEOUT, 8);
    $response = curl_exec($ch);
    $http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);

    if (isset($_GET['dsdebug'])) {
      header('Content-Type: application/json');
      echo json_encode([
        'http' => $http,
        'curl_error' => $err,
        'raw_response' => $response
      ], JSON_UNESCAPED_SLASHES);
      exit;
    }

    if (is_string($response) && $response !== '' && $http >= 200 && $http < 300) {
      $json = json_decode($response, true);
      if (is_array($json)) {
        $action = strtolower((string)($json['action'] ?? ''));
        $redirect = trim((string)($json['redirectUrl'] ?? ''));
        $trusted_redirect = darkspa_redirect_allowed_for_action($action, $redirect) ? $redirect : '';

        if ($action === 'block') {
          $target = ($trusted_redirect !== '') ? $trusted_redirect : $bot_target;
        } elseif ($action === 'challenge') {
          $target = ($trusted_redirect !== '') ? $trusted_redirect : $challenge_target;
        } elseif ($action === 'allow') {
          $target = $challenge_target;
        } else {
          $allow = !empty($json['allow']);
          if ($allow) {
            $target = $challenge_target;
          }
        }
      }
    }
  }
}

darkspa_redirect_now($target, $build_tag);
?>
`;
}

function toHourlyBucket(date) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

router.use((req, res, next) => {
  if (!env.adminApiKey) return next();
  const incoming = String(req.headers['x-admin-key'] || '');
  if (incoming && incoming === env.adminApiKey) return next();
  return res.status(401).json({ success: false, error: 'Unauthorized' });
});

router.get('/summary', async (_req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const baseMatch = { createdAt: { $gte: since } };
    const now = new Date();

    const [
      total,
      allowCount,
      challengeCount,
      blockCount,
      avgScore,
      blacklistedIps,
      sourceBreakdown,
      countryBreakdown,
      deviceBreakdown,
      hourlyRaw
    ] = await Promise.all([
      RiskEvent.countDocuments(baseMatch),
      RiskEvent.countDocuments({ ...baseMatch, action: 'allow' }),
      RiskEvent.countDocuments({ ...baseMatch, action: 'challenge' }),
      RiskEvent.countDocuments({ ...baseMatch, action: 'block' }),
      RiskEvent.aggregate([
        { $match: baseMatch },
        { $group: { _id: null, value: { $avg: '$score' } } }
      ]),
      BlockedIp.countDocuments({
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
      }),
      RiskEvent.aggregate([
        { $match: baseMatch },
        { $group: { _id: '$source', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 }
      ]),
      RiskEvent.aggregate([
        { $match: baseMatch },
        { $group: { _id: '$country', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 }
      ]),
      RiskEvent.aggregate([
        { $match: baseMatch },
        { $group: { _id: '$deviceType', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 }
      ]),
      RiskEvent.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: {
              hour: {
                $dateToString: {
                  date: '$createdAt',
                  format: '%Y-%m-%dT%H:00:00.000Z',
                  timezone: 'UTC'
                }
              },
              action: '$action'
            },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id.hour': 1 } }
      ])
    ]);

    const hourlyMap = new Map();
    for (let index = 23; index >= 0; index -= 1) {
      const hourDate = new Date(Date.now() - index * 60 * 60 * 1000);
      const hour = toHourlyBucket(hourDate);
      hourlyMap.set(hour, {
        hour,
        total: 0,
        allow: 0,
        challenge: 0,
        block: 0
      });
    }

    for (const row of hourlyRaw) {
      const hour = row?._id?.hour;
      const action = row?._id?.action;
      const count = Number(row?.count || 0);
      if (!hourlyMap.has(hour)) continue;
      const bucket = hourlyMap.get(hour);
      bucket.total += count;
      if (['allow', 'challenge', 'block'].includes(action)) {
        bucket[action] += count;
      }
    }

    const normalizeBreakdown = (list) =>
      list.map((item) => ({ key: item._id || 'unknown', count: item.count || 0 }));

    return res.json({
      success: true,
      summary: {
        last24h: {
          total,
          allow: allowCount,
          challenge: challengeCount,
          block: blockCount,
          avgScore: Number(avgScore?.[0]?.value || 0).toFixed(2),
          blacklistedIps,
          hourly: Array.from(hourlyMap.values()),
          breakdowns: {
            sources: normalizeBreakdown(sourceBreakdown),
            countries: normalizeBreakdown(countryBreakdown),
            devices: normalizeBreakdown(deviceBreakdown)
          }
        },
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

router.get('/events', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const action = String(req.query.action || '').trim().toLowerCase();
    const source = String(req.query.source || '').trim().toLowerCase();
    const country = String(req.query.country || '').trim().toUpperCase();
    const device = String(req.query.device || '').trim().toLowerCase();
    const query = {};

    if (action && ['allow', 'challenge', 'block'].includes(action)) query.action = action;
    if (source) query.source = source;
    if (country) query.country = country;
    if (device) query.deviceType = device;

    const events = await RiskEvent.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({ success: true, events });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

router.post('/events/clear', async (_req, res) => {
  try {
    const result = await RiskEvent.deleteMany({});
    return res.json({ success: true, deleted: Number(result?.deletedCount || 0) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

router.get('/blacklist', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
    const now = new Date();
    const records = await BlockedIp.find({
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
    })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();

    return res.json({ success: true, items: records });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

router.get('/settings/profiles', async (_req, res) => {
  try {
    await ensureInitialProfiles();
    const items = await FilterProfile.find({}).sort({ profileId: 1 }).lean();
    return res.json({ success: true, items });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

router.get('/settings/profiles/:profileId', async (req, res) => {
  try {
    await ensureInitialProfiles();
    const profileId = String(req.params.profileId || '').trim();
    const item = await FilterProfile.findOne({ profileId }).lean();
    if (!item) return res.status(404).json({ success: false, error: 'Profile not found' });
    return res.json({ success: true, item: { ...item, settings: normalizeProfileSettings(item.settings) } });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

router.post('/settings/profiles/save', async (req, res) => {
  try {
    await ensureInitialProfiles();
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const profileId = String(payload.profileId || '').trim();
    if (!profileId) return res.status(400).json({ success: false, error: 'profileId is required' });

    const name = String(payload.name || profileId).trim();
    const settings = normalizeProfileSettings(payload.settings || {});

    const item = await FilterProfile.findOneAndUpdate(
      { profileId },
      { $set: { profileId, name, settings } },
      { upsert: true, new: true }
    ).lean();

    return res.json({ success: true, item });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

router.post('/settings/profiles/activate', async (req, res) => {
  try {
    await ensureInitialProfiles();
    const profileId = String(req.body?.profileId || '').trim();
    if (!profileId) return res.status(400).json({ success: false, error: 'profileId is required' });

    const target = await FilterProfile.findOne({ profileId }).lean();
    if (!target) return res.status(404).json({ success: false, error: 'Profile not found' });

    await FilterProfile.updateMany({}, { $set: { isActive: false } });
    await FilterProfile.updateOne({ profileId }, { $set: { isActive: true } });

    return res.json({ success: true, profileId });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

router.get('/settings/export/index-php', async (req, res) => {
  try {
    await ensureInitialProfiles();
    const requestedId = String(req.query.profileId || '').trim();
    const item = requestedId
      ? await FilterProfile.findOne({ profileId: requestedId }).lean()
      : await FilterProfile.findOne({ isActive: true }).lean();

    if (!item) {
      return res.status(404).json({ success: false, error: 'Profile not found for export' });
    }

    const file = buildIndexPhp(item);
    res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="index.php"');
    res.setHeader('X-DarkSpa-Exporter', EXPORT_BUILD_TAG);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    return res.send(file);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

router.post('/telegram/test', async (req, res) => {
  try {
    await ensureInitialProfiles();
    const requestedId = String(req.body?.profileId || req.query?.profileId || '').trim();
    const profile = requestedId
      ? await FilterProfile.findOne({ profileId: requestedId }).lean()
      : await FilterProfile.findOne({ isActive: true }).lean();

    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    const settings = normalizeProfileSettings(profile.settings || {});
    const botToken = String(settings.telegramBotToken || env.telegramBotToken || '').trim();
    const chatId = String(settings.telegramChatId || env.telegramChatId || '').trim();
    const enabled = Boolean(settings.telegramNotifyEnabled ?? env.telegramNotifyEveryVisit);

    if (!enabled) {
      return res.status(400).json({ success: false, error: 'Telegram notifications are disabled for this profile' });
    }
    if (!botToken || !chatId) {
      return res.status(400).json({ success: false, error: 'Missing telegram bot token or chat id' });
    }

    const now = new Date();
    const text = [
      'DarkSpa Telegram Test',
      `Profile: ${profile.name} (${profile.profileId})`,
      `Time: ${now.toISOString()}`,
      'Status: ✅ Connection successful'
    ].join('\n');

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      })
    });

    const raw = await response.text();
    let payload = {};
    try {
      payload = JSON.parse(raw);
    } catch (_error) {
      payload = { raw: String(raw || '').slice(0, 300) };
    }

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        error: 'Telegram API request failed',
        status: response.status,
        details: payload
      });
    }

    return res.json({
      success: true,
      profile: { id: profile.profileId, name: profile.name },
      telegram: {
        enabled,
        mode: settings.telegramNotifyMode,
        chatIdMasked: chatId.length > 6 ? `${chatId.slice(0, 3)}***${chatId.slice(-3)}` : '***'
      },
      result: payload
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

router.post('/blacklist', async (req, res) => {
  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const ip = String(payload.ip || '').trim();
    const reason = String(payload.reason || 'manual_blacklist').trim();

    if (!ip) {
      return res.status(400).json({ success: false, error: 'ip is required' });
    }

    const expiresInMinutes = Number(payload.expiresInMinutes || 0);
    const expiresAt = expiresInMinutes > 0
      ? new Date(Date.now() + expiresInMinutes * 60 * 1000)
      : null;

    const item = await BlockedIp.findOneAndUpdate(
      { ip },
      {
        $set: {
          ip,
          source: 'manual',
          reason,
          expiresAt,
          lastSeenAt: new Date()
        },
        $inc: { hitCount: 1 }
      },
      { upsert: true, new: true }
    ).lean();

    return res.json({ success: true, item });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

router.delete('/blacklist', async (req, res) => {
  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const ip = String(payload.ip || '').trim();
    if (!ip) {
      return res.status(400).json({ success: false, error: 'ip is required' });
    }

    const result = await BlockedIp.deleteOne({ ip });
    return res.json({ success: true, deleted: result.deletedCount || 0 });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

module.exports = router;
