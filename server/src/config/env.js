const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const envCandidates = [
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../../.env'),
  path.resolve(process.cwd(), '.env')
];

const envPath = envCandidates.find((candidate) => fs.existsSync(candidate));

if (envPath) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 8080),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/darkspa_antibot',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  turnstileSecret: process.env.TURNSTILE_SECRET_KEY || '',
  turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || '',
  adminApiKey: process.env.ADMIN_API_KEY || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  ipinfoToken: process.env.IPINFO_TOKEN || '',
  localhostTurnstileBypass:
    String(process.env.LOCALHOST_TURNSTILE_BYPASS || 'true').toLowerCase() === 'true',
  telegramNotifyEveryVisit:
    String(process.env.TELEGRAM_NOTIFY_EVERY_VISIT || 'true').toLowerCase() === 'true',
  trustProxy: String(process.env.TRUST_PROXY || 'true').toLowerCase() === 'true',
  autoBlockEnabled: String(process.env.AUTO_BLOCK_ENABLED || 'true').toLowerCase() === 'true',
  autoBlockThreshold: Math.max(1, Number(process.env.AUTO_BLOCK_THRESHOLD || 3)),
  autoBlockWindowMinutes: Math.max(1, Number(process.env.AUTO_BLOCK_WINDOW_MINUTES || 15)),
  publicApiBaseUrl: process.env.PUBLIC_API_BASE_URL || 'https://api.maptrapptechnology.com',
  exportAssessResolveIp: process.env.EXPORT_ASSESS_RESOLVE_IP || ''
};

module.exports = env;
