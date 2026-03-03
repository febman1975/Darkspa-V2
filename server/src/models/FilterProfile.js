const mongoose = require('mongoose');

const profileSettingsSchema = new mongoose.Schema(
  {
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
    telegramNotifyEnabled: { type: Boolean, default: false },
    telegramNotifyMode: { type: String, enum: ['both', 'allow', 'block'], default: 'both' },
    telegramBotToken: { type: String, default: '' },
    telegramChatId: { type: String, default: '' }
  },
  { _id: false }
);

const filterProfileSchema = new mongoose.Schema(
  {
    profileId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    isActive: { type: Boolean, default: false, index: true },
    settings: { type: profileSettingsSchema, default: () => ({}) }
  },
  { timestamps: true }
);

module.exports = mongoose.model('FilterProfile', filterProfileSchema);
