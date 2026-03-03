const mongoose = require('mongoose');

const riskEventSchema = new mongoose.Schema(
  {
    fingerprintHash: { type: String, index: true },
    fingerprintVisitorId: { type: String, index: true, default: '' },
    fingerprintRequestId: { type: String, default: '' },
    sessionId: { type: String, index: true },
    ip: { type: String, index: true },
    score: { type: Number, required: true },
    action: { type: String, enum: ['allow', 'challenge', 'block'], required: true },
    challengePassed: { type: Boolean, default: false },
    source: { type: String, default: 'direct', index: true },
    country: { type: String, default: 'UNKNOWN', index: true },
    countryName: { type: String, default: '' },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    latitude: { type: String, default: '' },
    longitude: { type: String, default: '' },
    timezone: { type: String, default: '' },
    isp: { type: String, default: '' },
    org: { type: String, default: '' },
    asn: { type: String, default: '' },
    deviceType: { type: String, default: 'unknown', index: true },
    os: { type: String, default: 'unknown' },
    browser: { type: String, default: 'unknown' },
    referrer: { type: String, default: '' },
    path: { type: String, default: '' },
    behavior: {
      mouseMoves: { type: Number, default: 0 },
      clicks: { type: Number, default: 0 },
      keydowns: { type: Number, default: 0 },
      scrolls: { type: Number, default: 0 },
      dwellMs: { type: Number, default: 0 }
    },
    reason: { type: String, default: '' },
    userAgent: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('RiskEvent', riskEventSchema);
