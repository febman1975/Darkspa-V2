const RiskEvent = require('../models/RiskEvent');

function normalizeBehavior(behavior) {
  const source = behavior && typeof behavior === 'object' ? behavior : {};
  return {
    mouseMoves: Number(source.mouseMoves || 0),
    clicks: Number(source.clicks || 0),
    keydowns: Number(source.keydowns || 0),
    scrolls: Number(source.scrolls || 0),
    dwellMs: Number(source.dwellMs || 0)
  };
}

async function calculateRisk({ fingerprintHash, ip, behavior, challengePassed, settings }) {
  const runtimeSettings = settings && typeof settings === 'object' ? settings : {};
  const minInteractions = Math.max(0, Number(runtimeSettings.minInteractions ?? 5));
  const minBrowserTimeMs = Math.max(0, Number(runtimeSettings.minBrowserTimeMs ?? 2500));
  const challengeScore = Math.max(1, Number(runtimeSettings.challengeScore ?? 35));
  const blockScore = Math.max(1, Number(runtimeSettings.blockScore ?? 65));

  const normalizedBehavior = normalizeBehavior(behavior);
  let score = 0;
  const reasons = [];

  const interactionTotal =
    normalizedBehavior.mouseMoves +
    normalizedBehavior.clicks +
    normalizedBehavior.keydowns +
    normalizedBehavior.scrolls;

  if (interactionTotal < minInteractions) {
    score += 35;
    reasons.push('low_interaction');
  }

  if (normalizedBehavior.dwellMs < minBrowserTimeMs) {
    score += 25;
    reasons.push('short_dwell');
  }

  const since = new Date(Date.now() - 60 * 1000);
  const velocityQuery = {
    createdAt: { $gte: since },
    $or: [
      ...(fingerprintHash ? [{ fingerprintHash }] : []),
      ...(ip ? [{ ip }] : [])
    ]
  };

  if (velocityQuery.$or.length > 0) {
    const recentEvents = await RiskEvent.countDocuments(velocityQuery);
    if (recentEvents >= 10) {
      score += 30;
      reasons.push('high_velocity');
    } else if (recentEvents >= 5) {
      score += 15;
      reasons.push('medium_velocity');
    }
  }

  if (challengePassed) {
    score = Math.max(0, score - 40);
    reasons.push('challenge_passed');
  }

  let action = 'allow';
  if (score >= blockScore) action = 'block';
  else if (score >= challengeScore) action = 'challenge';

  return {
    score,
    action,
    reasons,
    behavior: normalizedBehavior
  };
}

module.exports = {
  calculateRisk,
  normalizeBehavior
};
