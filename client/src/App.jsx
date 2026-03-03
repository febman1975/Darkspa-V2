import { useEffect, useMemo, useRef, useState } from 'react';

const apiBase = import.meta.env.VITE_API_BASE_URL || '';
const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';
const localhostTurnstileBypass =
  String(import.meta.env.VITE_LOCALHOST_TURNSTILE_BYPASS ?? 'true').toLowerCase() === 'true';
const buildTimeAdminApiKey = import.meta.env.VITE_ADMIN_API_KEY || '';
const adminApiKeyStorageKey = 'darkspa_admin_api_key';
const fingerprintPublicKey = import.meta.env.VITE_FINGERPRINTJS_PUBLIC_KEY || '';
const fingerprintRegion = (import.meta.env.VITE_FINGERPRINTJS_REGION || 'us').toLowerCase();
const exportBuildTag = 'darkspa-assess-v5-20260302';
const uiBuildTag = 'ui-20260303-01';

const defaultSettings = {
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

function randomId() {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildFingerprint() {
  const parts = [
    navigator.userAgent,
    navigator.language,
    navigator.platform,
    String(navigator.hardwareConcurrency || 0),
    String(screen.width),
    String(screen.height),
    Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  ];

  return parts.join('|');
}

function getClientSource() {
  const params = new URLSearchParams(window.location.search || '');
  const utmSource = String(params.get('utm_source') || '').trim().toLowerCase();
  if (utmSource) return utmSource;

  const referrer = String(document.referrer || '').trim();
  if (!referrer) return 'direct';

  try {
    const host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
    return host || 'direct';
  } catch (_error) {
    return 'direct';
  }
}

function getBrowserLabel() {
  const ua = navigator.userAgent || '';
  const patterns = [
    [/Edg\/(\d+[\d.]*)/, 'Microsoft Edge'],
    [/OPR\/(\d+[\d.]*)/, 'Opera'],
    [/Chrome\/(\d+[\d.]*)/, 'Google Chrome'],
    [/Firefox\/(\d+[\d.]*)/, 'Mozilla Firefox'],
    [/Version\/(\d+[\d.]*)\s+Safari/, 'Safari']
  ];

  for (const [regex, name] of patterns) {
    const match = ua.match(regex);
    if (match) return `${name} ${match[1]}`;
  }
  return ua || 'Unknown';
}

function detectDeviceInfo() {
  const ua = (navigator.userAgent || '').toLowerCase();
  const isTablet = /ipad|tablet/.test(ua);
  const isMobile = !isTablet && /mobile|iphone|android/.test(ua);
  return {
    type: isTablet ? 'Tablet' : isMobile ? 'Mobile' : 'Desktop',
    mobile: isMobile,
    tablet: isTablet,
    touch: (navigator.maxTouchPoints || 0) > 0,
    maxTouchPoints: navigator.maxTouchPoints || 0
  };
}

function getPerformanceData() {
  const navigation = performance.getEntriesByType('navigation')[0];
  const paints = performance.getEntriesByType('paint');
  const firstPaint = paints.find((item) => item.name === 'first-paint');

  return {
    pageLoad: navigation ? `${Math.round(navigation.loadEventEnd)}ms` : 'Unknown',
    domReady: navigation ? `${Math.round(navigation.domContentLoadedEventEnd)}ms` : 'Unknown',
    firstPaint: firstPaint ? `${Math.round(firstPaint.startTime)}ms` : 'Unknown'
  };
}

async function collectClientMeta(sessionId) {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const memory = performance.memory || {};
  const batteryApi = navigator.getBattery ? await navigator.getBattery().catch(() => null) : null;

  return {
    browser: getBrowserLabel(),
    platform: navigator.platform || 'Unknown',
    languages: Array.isArray(navigator.languages) ? navigator.languages : [],
    online: navigator.onLine,
    cookiesEnabled: navigator.cookieEnabled,
    doNotTrack: navigator.doNotTrack || 'Not set',
    javaEnabled: navigator.javaEnabled ? navigator.javaEnabled() : false,
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
    device: detectDeviceInfo(),
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      colorDepth: screen.colorDepth,
      pixelRatio: window.devicePixelRatio || 1,
      orientation: screen.orientation?.type || 'Unknown'
    },
    page: {
      url: window.location.href,
      title: document.title || 'Unknown',
      protocol: window.location.protocol,
      referrer: document.referrer || 'Direct',
      origin: window.location.origin
    },
    connection: {
      type: connection?.type || 'Unknown',
      effectiveType: connection?.effectiveType || 'Unknown',
      downlink: connection?.downlink ?? 'Unknown',
      rtt: connection?.rtt ?? 'Unknown'
    },
    performance: getPerformanceData(),
    memory: {
      usedJSHeapSize: memory.usedJSHeapSize ? Math.round(memory.usedJSHeapSize / 1024 / 1024) : 'Unknown',
      totalJSHeapSize: memory.totalJSHeapSize ? Math.round(memory.totalJSHeapSize / 1024 / 1024) : 'Unknown',
      jsHeapSizeLimit: memory.jsHeapSizeLimit ? Math.round(memory.jsHeapSizeLimit / 1024 / 1024) : 'Unknown'
    },
    battery: batteryApi
      ? {
          level: `${Math.round((batteryApi.level || 0) * 100)}%`,
          charging: batteryApi.charging ? 'Yes' : 'No'
        }
      : { level: 'Unknown', charging: 'Unknown' },
    plugins: Array.from(navigator.plugins || []).map((plugin) => plugin.name).filter(Boolean),
    sessionId,
    visitTime: new Date().toLocaleString()
  };
}

export default function App() {
  const isLocalHostRuntime =
    typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const shouldBypassTurnstile = localhostTurnstileBypass && isLocalHostRuntime;

  const [tab, setTab] = useState('assess');
  const [adminApiKey, setAdminApiKey] = useState(() => {
    if (typeof window === 'undefined') return buildTimeAdminApiKey;
    const saved = window.localStorage.getItem(adminApiKeyStorageKey) || '';
    return saved || buildTimeAdminApiKey;
  });
  const [sessionId] = useState(() => randomId());
  const [turnstileToken, setTurnstileToken] = useState('');
  const [status, setStatus] = useState('Idle');
  const [result, setResult] = useState(null);
  const [manualToken, setManualToken] = useState('');
  const [fingerprintVisitorId, setFingerprintVisitorId] = useState('');
  const [fingerprintRequestId, setFingerprintRequestId] = useState('');
  const [fingerprintStatus, setFingerprintStatus] = useState('Not configured');
  const [clientMeta, setClientMeta] = useState({});

  const [summary, setSummary] = useState(null);
  const [events, setEvents] = useState([]);
  const [blacklist, setBlacklist] = useState([]);
  const [adminStatus, setAdminStatus] = useState('Idle');
  const [eventFilter, setEventFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [deviceFilter, setDeviceFilter] = useState('');
  const [ipToBlock, setIpToBlock] = useState('');
  const [blockReason, setBlockReason] = useState('manual_dashboard_block');

  const [profiles, setProfiles] = useState([]);
  const [selectedProfileId, setSelectedProfileId] = useState('profile_1');
  const [profileName, setProfileName] = useState('Profile 1');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const value = String(adminApiKey || '').trim();
    if (value) {
      window.localStorage.setItem(adminApiKeyStorageKey, value);
    } else {
      window.localStorage.removeItem(adminApiKeyStorageKey);
    }
  }, [adminApiKey]);

  function adminHeaders(extra = {}) {
    const key = String(adminApiKey || '').trim();
    return {
      ...extra,
      ...(key ? { 'x-admin-key': key } : {})
    };
  }
  const [settingsForm, setSettingsForm] = useState(defaultSettings);
  const [settingsStatus, setSettingsStatus] = useState('Idle');

  const startedAtRef = useRef(Date.now());
  const behaviorRef = useRef({ mouseMoves: 0, clicks: 0, keydowns: 0, scrolls: 0 });

  useEffect(() => {
    const onMove = () => { behaviorRef.current.mouseMoves += 1; };
    const onClick = () => { behaviorRef.current.clicks += 1; };
    const onKey = () => { behaviorRef.current.keydowns += 1; };
    const onScroll = () => { behaviorRef.current.scrolls += 1; };

    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('click', onClick, { passive: true });
    window.addEventListener('keydown', onKey, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });

    window.onTurnstileSuccess = (token) => {
      setTurnstileToken(token || '');
    };

    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll);
      if (window.onTurnstileSuccess) delete window.onTurnstileSuccess;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    collectClientMeta(sessionId)
      .then((meta) => {
        if (mounted) setClientMeta(meta);
      })
      .catch(() => {
        if (mounted) setClientMeta({ sessionId, visitTime: new Date().toLocaleString() });
      });

    return () => {
      mounted = false;
    };
  }, [sessionId]);

  useEffect(() => {
    async function bootstrapFingerprint() {
      if (!fingerprintPublicKey) {
        setFingerprintStatus('Not configured');
        return;
      }

      try {
        setFingerprintStatus('Loading...');
        const cdnHost =
          fingerprintRegion === 'eu'
            ? 'https://eu.fpjscdn.net'
            : fingerprintRegion === 'ap'
              ? 'https://ap.fpjscdn.net'
              : 'https://fpjscdn.net';
        const scriptUrl = `${cdnHost}/v3/${fingerprintPublicKey}`;

        const fingerprintModule = await import(
          /* @vite-ignore */
          scriptUrl
        );
        const agent = await fingerprintModule.load();
        const result = await agent.get();
        setFingerprintVisitorId(String(result?.visitorId || ''));
        setFingerprintRequestId(String(result?.requestId || ''));
        setFingerprintStatus('Ready');
      } catch (error) {
        const errorMessage = error?.message || 'fingerprint_load_failed';
        const errorName = error?.name || 'Error';
        setFingerprintStatus(`Error: ${errorName}: ${errorMessage}`);
      }
    }

    bootstrapFingerprint();
  }, []);

  const payloadPreview = useMemo(() => {
    const dwellMs = Date.now() - startedAtRef.current;
    return {
      sessionId,
      fingerprint: buildFingerprint(),
      behavior: { ...behaviorRef.current, dwellMs },
      source: getClientSource(),
      fingerprintVisitorId,
      fingerprintRequestId,
      clientMeta,
      referrer: document.referrer || '',
      path: window.location.pathname || '/',
      turnstileToken: manualToken || turnstileToken
    };
  }, [clientMeta, fingerprintRequestId, fingerprintVisitorId, manualToken, sessionId, turnstileToken]);

  function updateSettingsField(key, value) {
    setSettingsForm((previous) => ({ ...previous, [key]: value }));
  }

  async function runAssessment() {
    setStatus('Assessing...');
    const dwellMs = Date.now() - startedAtRef.current;

    const body = {
      sessionId,
      fingerprint: buildFingerprint(),
      behavior: {
        ...behaviorRef.current,
        dwellMs
      },
      source: getClientSource(),
      fingerprintVisitorId,
      fingerprintRequestId,
      clientMeta,
      referrer: document.referrer || '',
      path: window.location.pathname || '/',
      turnstileToken: manualToken || turnstileToken
    };

    try {
      const response = await fetch(`${apiBase}/api/antibot/assess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await response.json();
      setResult(data);
      setStatus(data?.success ? 'Done' : 'Error');
    } catch (error) {
      setResult({ success: false, error: error.message || String(error) });
      setStatus('Error');
    }
  }

  async function fetchSummary() {
    setAdminStatus('Loading summary...');
    try {
      const response = await fetch(`${apiBase}/api/admin/summary`, {
        headers: adminHeaders()
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Failed summary request');
      setSummary(data.summary);
      setAdminStatus('Summary loaded');
    } catch (error) {
      setAdminStatus(`Summary error: ${error.message || String(error)}`);
    }
  }

  async function fetchEvents() {
    setAdminStatus('Loading events...');
    const params = new URLSearchParams();
    params.set('limit', '50');
    if (eventFilter) params.set('action', eventFilter);
    if (sourceFilter) params.set('source', sourceFilter);
    if (countryFilter) params.set('country', countryFilter);
    if (deviceFilter) params.set('device', deviceFilter);
    try {
      const response = await fetch(`${apiBase}/api/admin/events?${params.toString()}`, {
        headers: adminHeaders()
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Failed events request');
      setEvents(Array.isArray(data.events) ? data.events : []);
      setAdminStatus('Events loaded');
    } catch (error) {
      setAdminStatus(`Events error: ${error.message || String(error)}`);
    }
  }

  async function fetchBlacklist() {
    setAdminStatus('Loading blacklist...');
    try {
      const response = await fetch(`${apiBase}/api/admin/blacklist?limit=200`, {
        headers: adminHeaders()
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Failed blacklist request');
      setBlacklist(Array.isArray(data.items) ? data.items : []);
      setAdminStatus('Blacklist loaded');
    } catch (error) {
      setAdminStatus(`Blacklist error: ${error.message || String(error)}`);
    }
  }

  async function addBlacklist() {
    const ip = ipToBlock.trim();
    if (!ip) {
      setAdminStatus('Blacklist error: IP is required');
      return;
    }

    setAdminStatus('Adding blacklist IP...');
    try {
      const response = await fetch(`${apiBase}/api/admin/blacklist`, {
        method: 'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ip, reason: blockReason || 'manual_dashboard_block' })
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Failed to add blacklist IP');
      setIpToBlock('');
      await fetchBlacklist();
      await fetchSummary();
      setAdminStatus('Blacklist IP added');
    } catch (error) {
      setAdminStatus(`Blacklist add error: ${error.message || String(error)}`);
    }
  }

  async function removeBlacklist(ip) {
    setAdminStatus('Removing blacklist IP...');
    try {
      const response = await fetch(`${apiBase}/api/admin/blacklist`, {
        method: 'DELETE',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ip })
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Failed to remove blacklist IP');
      await fetchBlacklist();
      await fetchSummary();
      setAdminStatus('Blacklist IP removed');
    } catch (error) {
      setAdminStatus(`Blacklist remove error: ${error.message || String(error)}`);
    }
  }

  async function fetchProfiles() {
    setSettingsStatus('Loading profiles...');
    try {
      const response = await fetch(`${apiBase}/api/admin/settings/profiles`, {
        headers: adminHeaders()
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Failed profile list request');
      const items = Array.isArray(data.items) ? data.items : [];
      setProfiles(items);

      const active = items.find((item) => item.isActive) || items[0];
      if (active) {
        setSelectedProfileId(active.profileId);
        setProfileName(active.name || active.profileId);
        setSettingsForm({ ...defaultSettings, ...(active.settings || {}) });
      }
      setSettingsStatus('Profiles loaded');
    } catch (error) {
      setSettingsStatus(`Profiles error: ${error.message || String(error)}`);
    }
  }

  async function loadProfile(profileId) {
    setSettingsStatus('Loading profile...');
    try {
      const response = await fetch(`${apiBase}/api/admin/settings/profiles/${profileId}`, {
        headers: adminHeaders()
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Failed profile load');
      const item = data.item;
      setSelectedProfileId(item.profileId);
      setProfileName(item.name || item.profileId);
      setSettingsForm({ ...defaultSettings, ...(item.settings || {}) });
      setSettingsStatus(`Loaded ${item.name || item.profileId}`);
    } catch (error) {
      setSettingsStatus(`Load error: ${error.message || String(error)}`);
    }
  }

  async function saveProfile() {
    setSettingsStatus('Saving profile...');
    try {
      const response = await fetch(`${apiBase}/api/admin/settings/profiles/save`, {
        method: 'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          profileId: selectedProfileId,
          name: profileName || selectedProfileId,
          settings: {
            ...settingsForm,
            minInteractions: Number(settingsForm.minInteractions || 0),
            minBrowserTimeMs: Number(settingsForm.minBrowserTimeMs || 0),
            challengeScore: Number(settingsForm.challengeScore || 35),
            blockScore: Number(settingsForm.blockScore || 65),
            autoBlockThreshold: Number(settingsForm.autoBlockThreshold || 3),
            autoBlockWindowMinutes: Number(settingsForm.autoBlockWindowMinutes || 15)
          }
        })
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Failed profile save');
      await fetchProfiles();
      setSettingsStatus('Profile saved');
    } catch (error) {
      setSettingsStatus(`Save error: ${error.message || String(error)}`);
    }
  }

  async function activateProfile() {
    setSettingsStatus('Activating profile...');
    try {
      const response = await fetch(`${apiBase}/api/admin/settings/profiles/activate`, {
        method: 'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ profileId: selectedProfileId })
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Failed profile activate');
      await fetchProfiles();
      setSettingsStatus(`Active profile: ${selectedProfileId}`);
    } catch (error) {
      setSettingsStatus(`Activate error: ${error.message || String(error)}`);
    }
  }

  async function downloadIndexPhp() {
    setSettingsStatus('Preparing index.php download...');
    try {
      const endpoint = `${apiBase}/api/admin/settings/export/index-php?profileId=${encodeURIComponent(selectedProfileId)}&t=${Date.now()}`;
      const response = await fetch(endpoint, { headers: adminHeaders() });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || 'Export failed');
      }

      const fileText = await response.text();
      const expectedMarker = `$build_tag = '${exportBuildTag}';`;
      const exporterHeader = String(response.headers.get('x-darkspa-exporter') || '').trim();

      if (!fileText.includes(expectedMarker)) {
        throw new Error(`Exporter is not ${exportBuildTag}. Endpoint: ${endpoint}`);
      }

      if (fileText.includes('decideAndRedirect') || fileText.includes('Checking browser...')) {
        throw new Error(`Legacy template detected from exporter. Endpoint: ${endpoint}`);
      }

      if (exporterHeader && exporterHeader !== exportBuildTag) {
        throw new Error(`Exporter header mismatch (${exporterHeader}). Endpoint: ${endpoint}`);
      }

      const blob = new Blob([fileText], { type: 'application/x-httpd-php' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'index.php';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);

      setSettingsStatus(`Downloaded index.php (${exportBuildTag})`);
    } catch (error) {
      setSettingsStatus(`Download error: ${error.message || String(error)}`);
    }
  }

  async function refreshAdmin() {
    await Promise.all([fetchSummary(), fetchEvents(), fetchBlacklist()]);
  }

  useEffect(() => {
    if (tab !== 'admin') return;
    refreshAdmin();
  }, [tab, eventFilter, sourceFilter, countryFilter, deviceFilter]);

  useEffect(() => {
    if (tab !== 'admin') return undefined;
    const intervalId = window.setInterval(() => {
      refreshAdmin();
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [tab, eventFilter, sourceFilter, countryFilter, deviceFilter]);

  useEffect(() => {
    if (tab !== 'settings') return;
    fetchProfiles();
  }, [tab]);

  const sourceOptions = summary?.last24h?.breakdowns?.sources || [];
  const countryOptions = summary?.last24h?.breakdowns?.countries || [];
  const deviceOptions = summary?.last24h?.breakdowns?.devices || [];
  const hourly = summary?.last24h?.hourly || [];
  const maxHourly = Math.max(1, ...hourly.map((item) => Number(item.total || 0)));

  const actionClass = result?.action || 'allow';

  return (
    <div className="app">
      <div className="card">
        <h1>DarkSpaAntibot</h1>
        <p className="sub">Fingerprint + interaction telemetry + challenge verification ({uiBuildTag})</p>

        <div className="tabs">
          <button className={`tab-btn ${tab === 'assess' ? 'active' : ''}`} onClick={() => setTab('assess')}>Assessment</button>
          <button className={`tab-btn ${tab === 'admin' ? 'active' : ''}`} onClick={() => setTab('admin')}>Admin Dashboard</button>
          <button className={`tab-btn ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>Settings</button>
        </div>

        <div className="grid" style={{ marginTop: 12 }}>
          <div>
            <label>Admin API Key</label>
            <input
              type="password"
              value={adminApiKey}
              onChange={(event) => setAdminApiKey(event.target.value)}
              placeholder="Paste ADMIN_API_KEY"
            />
          </div>
        </div>

        {tab === 'assess' ? (
          <>
            <p className="sub" style={{ marginTop: 8 }}>
              Request status <span className={`tag ${actionClass}`}>{result?.action || status}</span>
            </p>

            <div className="grid">
              <div>
                <label>Session ID</label>
                <input value={sessionId} readOnly />
              </div>
              <div>
                <label>Status</label>
                <input value={status} readOnly />
              </div>
              <div>
                <label>Fingerprint Status</label>
                <input value={fingerprintStatus} readOnly />
              </div>
              <div>
                <label>Fingerprint Visitor ID</label>
                <input value={fingerprintVisitorId || 'N/A'} readOnly />
              </div>
            </div>

            {turnstileSiteKey && !shouldBypassTurnstile ? (
              <div style={{ marginTop: 14 }}>
                <label>Cloudflare Turnstile</label>
                <div className="cf-turnstile" data-sitekey={turnstileSiteKey} data-callback="onTurnstileSuccess"></div>
              </div>
            ) : (
              <div style={{ marginTop: 14 }}>
                <label>{shouldBypassTurnstile ? 'Turnstile (localhost bypass active)' : 'Manual challenge token (optional)'}</label>
                <input
                  value={manualToken}
                  onChange={(event) => setManualToken(event.target.value)}
                  placeholder="Paste challenge token here"
                />
              </div>
            )}

            <button onClick={runAssessment}>Run Anti-Bot Assessment</button>

            <div className="output">
              Payload Preview:\n{JSON.stringify(payloadPreview, null, 2)}
            </div>

            <div className="output">
              API Result:\n{result ? JSON.stringify(result, null, 2) : 'No result yet'}
            </div>
          </>
        ) : tab === 'admin' ? (
          <>
            <p className="sub" style={{ marginTop: 8 }}>Traffic decisions, IP controls, and event stream</p>

            <div className="kpi-grid">
              <div className="kpi-card"><span>Total (24h)</span><strong>{summary?.last24h?.total ?? 0}</strong></div>
              <div className="kpi-card"><span>Allow</span><strong>{summary?.last24h?.allow ?? 0}</strong></div>
              <div className="kpi-card"><span>Challenge</span><strong>{summary?.last24h?.challenge ?? 0}</strong></div>
              <div className="kpi-card"><span>Block</span><strong>{summary?.last24h?.block ?? 0}</strong></div>
              <div className="kpi-card"><span>Avg Score</span><strong>{summary?.last24h?.avgScore ?? '0.00'}</strong></div>
              <div className="kpi-card"><span>Blacklisted IPs</span><strong>{summary?.last24h?.blacklistedIps ?? 0}</strong></div>
            </div>

            <div className="grid" style={{ alignItems: 'end', marginTop: 12 }}>
              <div><label>Filter Action</label><select value={eventFilter} onChange={(event) => setEventFilter(event.target.value)}><option value="">All</option><option value="allow">allow</option><option value="challenge">challenge</option><option value="block">block</option></select></div>
              <div><label>Filter Source</label><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="">All</option>{sourceOptions.map((item) => (<option key={item.key} value={item.key}>{item.key}</option>))}</select></div>
              <div><label>Filter Country</label><select value={countryFilter} onChange={(event) => setCountryFilter(event.target.value)}><option value="">All</option>{countryOptions.map((item) => (<option key={item.key} value={item.key}>{item.key}</option>))}</select></div>
              <div><label>Filter Device</label><select value={deviceFilter} onChange={(event) => setDeviceFilter(event.target.value)}><option value="">All</option>{deviceOptions.map((item) => (<option key={item.key} value={item.key}>{item.key}</option>))}</select></div>
              <div><label>Admin Status</label><input value={adminStatus} readOnly /></div>
            </div>

            <div className="actions-row">
              <button onClick={refreshAdmin}>Refresh Dashboard</button>
              <button onClick={fetchEvents}>Reload Events</button>
              <button onClick={fetchBlacklist}>Reload Blacklist</button>
            </div>

            <div className="analytics-grid" style={{ marginTop: 14 }}>
              <div className="table-wrap">
                <h3>Hourly Traffic (24h)</h3>
                <div className="chart-wrap">
                  {hourly.length === 0 ? <div className="empty">No hourly data</div> : hourly.map((item) => {
                    const total = Number(item.total || 0);
                    const width = Math.max(2, Math.round((total / maxHourly) * 100));
                    const label = String(item.hour || '').slice(11, 16);
                    return (
                      <div className="bar-row" key={item.hour}>
                        <span>{label}</span>
                        <div className="bar-track"><div className="bar-fill" style={{ width: `${width}%` }}></div></div>
                        <strong>{total}</strong>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="table-wrap"><h3>Traffic Source Breakdown</h3><table className="table"><thead><tr><th>Source</th><th>Hits</th></tr></thead><tbody>{sourceOptions.length === 0 ? <tr><td colSpan="2">No source data</td></tr> : sourceOptions.map((item) => (<tr key={item.key}><td>{item.key}</td><td>{item.count}</td></tr>))}</tbody></table></div>
              <div className="table-wrap"><h3>Country Breakdown</h3><table className="table"><thead><tr><th>Country</th><th>Hits</th></tr></thead><tbody>{countryOptions.length === 0 ? <tr><td colSpan="2">No country data</td></tr> : countryOptions.map((item) => (<tr key={item.key}><td>{item.key}</td><td>{item.count}</td></tr>))}</tbody></table></div>
              <div className="table-wrap"><h3>Device Breakdown</h3><table className="table"><thead><tr><th>Device</th><th>Hits</th></tr></thead><tbody>{deviceOptions.length === 0 ? <tr><td colSpan="2">No device data</td></tr> : deviceOptions.map((item) => (<tr key={item.key}><td>{item.key}</td><td>{item.count}</td></tr>))}</tbody></table></div>
            </div>

            <div className="grid" style={{ marginTop: 12 }}>
              <div><label>IP to blacklist</label><input value={ipToBlock} onChange={(event) => setIpToBlock(event.target.value)} placeholder="e.g. 203.0.113.12" /></div>
              <div><label>Reason</label><input value={blockReason} onChange={(event) => setBlockReason(event.target.value)} /></div>
            </div>

            <div className="actions-row" style={{ marginTop: 10 }}>
              <button onClick={addBlacklist}>Add Blacklist IP</button>
            </div>

            <div className="table-wrap" style={{ marginTop: 14 }}>
              <h3>Recent Events</h3>
              <table className="table">
                <thead><tr><th>Time</th><th>Location & Network</th><th>Device</th><th>Source</th><th>Action</th><th>Score</th><th>Reason</th></tr></thead>
                <tbody>
                  {events.length === 0 ? <tr><td colSpan="7">No events loaded</td></tr> : events.map((event) => (
                    <tr key={event._id}>
                      <td>{event.createdAt ? new Date(event.createdAt).toLocaleString() : '-'}</td>
                      <td style={{ whiteSpace: 'pre-line' }}>
                        {`- IP Address: ${event.ip || '-'}\n- Location: ${event.city || 'Unknown'}, ${event.state || 'Unknown'}\n- Country: ${event.countryName || 'Unknown'} (${event.country || 'UNKNOWN'})\n- Coordinates: ${event.latitude || 'Unknown'}, ${event.longitude || 'Unknown'}\n- ISP: ${event.isp || 'Unknown'}\n- Organization: ${event.org || 'Unknown'}\n- ASN: ${event.asn || 'Unknown'}\n- Timezone: ${event.timezone || 'Unknown'}`}
                      </td>
                      <td>{event.deviceType || 'unknown'}</td>
                      <td>{event.source || 'direct'}</td>
                      <td><span className={`tag ${event.action || 'allow'}`}>{event.action || '-'}</span></td>
                      <td>{event.score ?? '-'}</td>
                      <td>{event.reason || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="table-wrap" style={{ marginTop: 14 }}>
              <h3>Active Blacklist</h3>
              <table className="table">
                <thead><tr><th>IP</th><th>Source</th><th>Reason</th><th>Hits</th><th>Action</th></tr></thead>
                <tbody>
                  {blacklist.length === 0 ? <tr><td colSpan="5">No blacklisted IPs</td></tr> : blacklist.map((item) => (
                    <tr key={item._id || item.ip}>
                      <td>{item.ip}</td>
                      <td>{item.source || 'manual'}</td>
                      <td>{item.reason || '-'}</td>
                      <td>{item.hitCount ?? 0}</td>
                      <td><button className="danger-btn" onClick={() => removeBlacklist(item.ip)}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <>
            <p className="sub" style={{ marginTop: 8 }}>
              Configure filters per project profile, choose active routing, then download your deploy-ready index.php.
            </p>

            <div className="grid" style={{ alignItems: 'end' }}>
              <div>
                <label>Profile</label>
                <select
                  value={selectedProfileId}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    setSelectedProfileId(nextId);
                    loadProfile(nextId);
                  }}
                >
                  {profiles.map((profile) => (
                    <option key={profile.profileId} value={profile.profileId}>
                      {profile.profileId} - {profile.name}{profile.isActive ? ' (active)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Project/Profile Name</label>
                <input value={profileName} onChange={(event) => setProfileName(event.target.value)} />
              </div>
            </div>

            <div className="grid" style={{ marginTop: 12 }}>
              <div>
                <label>Filter Level</label>
                <select value={settingsForm.filterLevel} onChange={(event) => updateSettingsField('filterLevel', event.target.value)}>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="custom">custom</option>
                </select>
              </div>
              <div>
                <label>Min Browser Time (ms)</label>
                <input type="number" value={settingsForm.minBrowserTimeMs} onChange={(event) => updateSettingsField('minBrowserTimeMs', Number(event.target.value || 0))} />
              </div>
              <div>
                <label>Min Interactions</label>
                <input type="number" value={settingsForm.minInteractions} onChange={(event) => updateSettingsField('minInteractions', Number(event.target.value || 0))} />
              </div>
              <div>
                <label>Challenge Score</label>
                <input type="number" value={settingsForm.challengeScore} onChange={(event) => updateSettingsField('challengeScore', Number(event.target.value || 0))} />
              </div>
              <div>
                <label>Block Score</label>
                <input type="number" value={settingsForm.blockScore} onChange={(event) => updateSettingsField('blockScore', Number(event.target.value || 0))} />
              </div>
              <div>
                <label>Auto Block Threshold</label>
                <input type="number" value={settingsForm.autoBlockThreshold} onChange={(event) => updateSettingsField('autoBlockThreshold', Number(event.target.value || 0))} />
              </div>
              <div>
                <label>Auto Block Window (minutes)</label>
                <input type="number" value={settingsForm.autoBlockWindowMinutes} onChange={(event) => updateSettingsField('autoBlockWindowMinutes', Number(event.target.value || 0))} />
              </div>
              <div>
                <label>Auto Block Enabled</label>
                <select value={settingsForm.autoBlockEnabled ? 'true' : 'false'} onChange={(event) => updateSettingsField('autoBlockEnabled', event.target.value === 'true')}>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              </div>
              <div>
                <label>Telegram Notify</label>
                <select value={settingsForm.telegramNotifyEnabled ? 'true' : 'false'} onChange={(event) => updateSettingsField('telegramNotifyEnabled', event.target.value === 'true')}>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              </div>
              <div>
                <label>Telegram Notify Mode</label>
                <select value={settingsForm.telegramNotifyMode || 'both'} onChange={(event) => updateSettingsField('telegramNotifyMode', event.target.value)}>
                  <option value="both">both (allow + block)</option>
                  <option value="allow">allow only</option>
                  <option value="block">block only</option>
                </select>
              </div>
            </div>

            <div className="grid" style={{ marginTop: 12 }}>
              <div>
                <label>Human Redirect URL</label>
                <input value={settingsForm.humanRedirectUrl} onChange={(event) => updateSettingsField('humanRedirectUrl', event.target.value)} />
              </div>
              <div>
                <label>Bot Redirect URL</label>
                <input value={settingsForm.botRedirectUrl} onChange={(event) => updateSettingsField('botRedirectUrl', event.target.value)} />
              </div>
              <div>
                <label>Telegram Bot Token</label>
                <input value={settingsForm.telegramBotToken || ''} onChange={(event) => updateSettingsField('telegramBotToken', event.target.value)} placeholder="123456:ABC..." />
              </div>
              <div>
                <label>Telegram Chat ID</label>
                <input value={settingsForm.telegramChatId || ''} onChange={(event) => updateSettingsField('telegramChatId', event.target.value)} placeholder="e.g. 1713866119" />
              </div>
              <div>
                <label>Settings Status</label>
                <input value={settingsStatus} readOnly />
              </div>
            </div>

            <div className="actions-row">
              <button onClick={saveProfile}>Save Profile</button>
              <button onClick={activateProfile}>Set As Active Profile</button>
              <button onClick={downloadIndexPhp}>Download index.php</button>
              <button onClick={fetchProfiles}>Reload Profiles</button>
            </div>

            <div className="output">
              Upload flow for cPanel:\n1) Click "Download index.php"\n2) Open cPanel File Manager\n3) Upload file into your site root (public_html)\n4) Ensure filename is index.php\n5) Done — routing uses this profile's filter settings.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
