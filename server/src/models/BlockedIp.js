const mongoose = require('mongoose');

const blockedIpSchema = new mongoose.Schema(
  {
    ip: { type: String, required: true, unique: true, index: true },
    source: { type: String, enum: ['manual', 'auto', 'real_device_only', 'vpn_proxy'], default: 'manual' },
    reason: { type: String, default: '' },
    hitCount: { type: Number, default: 0 },
    lastSeenAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null, index: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('BlockedIp', blockedIpSchema);
