const env = require('../config/env');

function ipv4ToInt(ip) {
  const parts = String(ip || '')
    .trim()
    .split('.')
    .map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }

  return (((parts[0] << 24) >>> 0) + ((parts[1] << 16) >>> 0) + ((parts[2] << 8) >>> 0) + (parts[3] >>> 0)) >>> 0;
}

function networkContainsIp(ip, network) {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;

  const raw = String(network || '').trim();
  if (!raw) return false;

  if (!raw.includes('/')) {
    const singleIpInt = ipv4ToInt(raw);
    return singleIpInt !== null && singleIpInt === ipInt;
  }

  const [baseIp, cidrRaw] = raw.split('/');
  const baseIpInt = ipv4ToInt(baseIp);
  const cidr = Number(cidrRaw);
  if (baseIpInt === null || !Number.isInteger(cidr) || cidr < 0 || cidr > 32) return false;

  const mask = cidr === 0 ? 0 : ((0xffffffff << (32 - cidr)) >>> 0);
  return ((ipInt & mask) >>> 0) === ((baseIpInt & mask) >>> 0);
}

function parsePossibleJsonOrNdjson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (_error) {
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;

  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch (_error) {
    }
  }

  return parsed.length ? parsed : null;
}

function pickGeoRecordForIp(ip, payload) {
  if (!payload) return null;
  if (!Array.isArray(payload)) return payload;
  if (!payload.length) return null;

  const networkMatch = payload.find((item) => networkContainsIp(ip, item?.network || item?.cidr));
  return networkMatch || payload[0];
}

function isPublicIp(ip) {
  const value = String(ip || '').trim();
  if (!value) return false;
  if (value === '::1' || value === '127.0.0.1') return false;
  if (value.startsWith('::ffff:127.')) return false;
  if (value.startsWith('10.') || value.startsWith('192.168.')) return false;

  const octets = value.split('.');
  if (octets.length === 4 && octets.every((segment) => /^\d+$/.test(segment))) {
    const first = Number(octets[0]);
    const second = Number(octets[1]);
    if (first === 172 && second >= 16 && second <= 31) return false;
  }

  return true;
}

function normalizeGeoPayload(data) {
  return {
    city: String(data.city || '').trim(),
    region: String(data.region || '').trim(),
    state: String(data.state || data.region || '').trim(),
    country: String(data.country || '').trim(),
    countryCode: String(data.countryCode || '').trim(),
    latitude: data.latitude ?? '',
    longitude: data.longitude ?? '',
    timezone: String(data.timezone || '').trim(),
    isp: String(data.isp || '').trim(),
    org: String(data.org || '').trim(),
    asn: String(data.asn || '').trim()
  };
}

async function lookupGeoFromIpinfo(ip, token) {
  if (!token) return null;

  try {
    const response = await fetch(`https://api.ipinfo.io/lite/${encodeURIComponent(ip)}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      }
    });
    if (!response.ok) return null;

    const text = await response.text();
    const parsed = parsePossibleJsonOrNdjson(text);
    const data = pickGeoRecordForIp(ip, parsed);
    if (!data || data.error) return null;

    const countryCode = String(data.country_code || data.country || '').trim();
    return normalizeGeoPayload({
      city: data.city,
      region: data.region || data.region_name,
      state: data.region || data.region_name,
      country: countryCode,
      countryCode,
      latitude: data.latitude,
      longitude: data.longitude,
      timezone: data.timezone
    });
  } catch (_error) {
    return null;
  }
}

async function lookupGeoFromIpapiIs(ip) {
  try {
    const response = await fetch(`https://api.ipapi.is/?q=${encodeURIComponent(ip)}`, {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) return null;

    const text = await response.text();
    const parsed = parsePossibleJsonOrNdjson(text);
    const data = pickGeoRecordForIp(ip, parsed);
    if (!data || data.error) return null;

    const location = data.location && typeof data.location === 'object' ? data.location : data;
    const countryCode = String(location.country_code || location.country || '').trim();

    return normalizeGeoPayload({
      city: location.city,
      region: location.state || location.region,
      state: location.state || location.region,
      country: location.country || countryCode,
      countryCode,
      latitude: location.latitude,
      longitude: location.longitude,
      timezone: location.timezone,
      isp: data.company?.name,
      org: data.company?.name,
      asn: data.asn?.asn
    });
  } catch (_error) {
    return null;
  }
}

async function lookupGeoFromIpwho(ip) {
  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) return null;

    const data = await response.json();
    if (!data || data.success === false) return null;

    return normalizeGeoPayload({
      city: data.city,
      region: data.region,
      state: data.region,
      country: data.country,
      countryCode: data.country_code,
      latitude: data.latitude,
      longitude: data.longitude,
      timezone: data.timezone?.id,
      isp: data.connection?.isp,
      org: data.connection?.org,
      asn: data.connection?.asn
    });
  } catch (_error) {
    return null;
  }
}

async function lookupGeoFromIpapi(ip) {
  try {
    const response = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) return null;

    const data = await response.json();
    if (!data || data.error) return null;

    const countryCode = String(data.country_code || '').trim();
    return normalizeGeoPayload({
      city: data.city,
      region: data.region,
      state: data.region,
      country: data.country_name || countryCode,
      countryCode,
      latitude: data.latitude,
      longitude: data.longitude,
      timezone: data.timezone,
      isp: data.org,
      org: data.org,
      asn: data.asn
    });
  } catch (_error) {
    return null;
  }
}

async function lookupGeo(ip) {
  if (!isPublicIp(ip)) return null;
  const token = String(env.ipinfoToken || '').trim();

  const providers = [
    () => lookupGeoFromIpinfo(ip, token),
    () => lookupGeoFromIpwho(ip),
    () => lookupGeoFromIpapi(ip),
    () => lookupGeoFromIpapiIs(ip)
  ];

  const merged = {
    city: '',
    region: '',
    state: '',
    country: '',
    countryCode: '',
    latitude: '',
    longitude: '',
    timezone: '',
    isp: '',
    org: '',
    asn: ''
  };

  for (const getGeo of providers) {
    const result = await getGeo();
    if (!result) continue;

    for (const [key, value] of Object.entries(result)) {
      if (!merged[key] && value) {
        merged[key] = value;
      }
    }

    if (merged.city && (merged.state || merged.region) && (merged.countryCode || merged.country)) {
      break;
    }
  }

  if (!merged.country && !merged.countryCode && !merged.city && !merged.state && !merged.region) {
    return null;
  }

  return merged;
}

module.exports = {
  lookupGeo
};
