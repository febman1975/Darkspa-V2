const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const env = require('./config/env');
const { connectDatabase } = require('./config/db');
const healthRoutes = require('./routes/health');
const antiBotRoutes = require('./routes/antibot');
const adminRoutes = require('./routes/admin');

const app = express();

const defaultCorsOrigins = ['http://localhost:5173', 'https://web-production-fc4b0.up.railway.app'];

const corsAllowList = [
  ...new Set([
    ...defaultCorsOrigins,
    ...String(env.corsOrigin || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
  ])
];

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  if (corsAllowList.includes('*')) return true;
  return corsAllowList.includes(origin);
}

if (env.trustProxy) {
  app.set('trust proxy', 1);
}

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedCorsOrigin(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.use('/api', healthRoutes);
app.use('/api/antibot', antiBotRoutes);
app.use('/api/admin', adminRoutes);

const challengePageFile = path.resolve(__dirname, '../../challenge-page/index.html');
if (fs.existsSync(challengePageFile)) {
  app.get(['/challenge', '/challenge/index.html'], (_req, res) => {
    return res.sendFile(challengePageFile, {
      cacheControl: false,
      etag: false,
      lastModified: false,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'Content-Security-Policy': [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          "connect-src 'self' https://challenges.cloudflare.com",
          "frame-src https://challenges.cloudflare.com",
          "font-src 'self' data:",
          "base-uri 'self'",
          "form-action 'self'"
        ].join('; ')
      }
    });
  });
}

const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    return res.sendFile(path.join(clientDist, 'index.html'));
  });
}

async function start() {
  try {
    await connectDatabase(env.mongoUri);
    app.listen(env.port, env.host, () => {
      console.log(`DarkSpaAntibot API running on http://${env.host}:${env.port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error.message || error);
    process.exit(1);
  }
}

start();
