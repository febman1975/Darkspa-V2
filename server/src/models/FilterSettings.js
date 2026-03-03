const mongoose = require('mongoose');

const filterSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true, default: 'default' },
    filterLevel: { type: String, enum: ['low', 'medium', 'high', 'custom'], default: 'medium' },
    humanRedirectUrl: { type: String, default: '' },
    botRedirectUrl: { type: String, default: '' },
    challengeRedirectUrl: { type: String, default: '' },
    minInteractions: { type: Number, default: 5 },
    minBrowserTimeMs: { type: Number, default: 2500 },
    challengeScore: { type: Number, default: 35 },
    blockScore: { type: Number, default: 65 },
    autoBlockEnabled: { type: Boolean, default: true },
    autoBlockThreshold: { type: Number, default: 3 },
    autoBlockWindowMinutes: { type: Number, default: 15 },
    updatedBy: { type: String, default: 'dashboard' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('FilterSettings', filterSettingsSchema);
