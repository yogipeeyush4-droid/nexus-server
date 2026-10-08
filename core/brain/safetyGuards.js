// core/brain/safetyGuards.js — Hard Limits & Audit
'use strict';

const fs = require('fs');
const path = require('path');

const AUDIT_PATH = path.join(__dirname, '..', '..', 'data', 'brain_audit.log');

// 🚨 HARD LIMITS — ye kabhi nahi tootenge
const LIMITS = {
  maxGoalsActive: 20,              // ek time pe max 20 goals
  maxGoalsAddPerDay: 50,           // 1 din mein max 50 naye
  maxKnowledgeNodes: 10000,        // knowledge graph cap
  maxStrategyVariants: 100,        // strategy pool cap
  maxCodeSuggestionsPending: 30,   // pending suggestions cap
  maxMemoryFileKB: 5120,           // 5 MB max
  forbiddenFilePatterns: [         // ye files kabhi modify nahi
    /server\.js$/i,
    /package\.json$/i,
    /\.env$/i,
    /safetyGuards\.js$/i,
    /brainCore\.js$/i,
  ],
  forbiddenActions: [
    'write_file_outside_data',
    'delete_file',
    'modify_source_code',
    'change_safety_limits',
    'execute_shell',
    'network_post',
  ],
};

function isForbiddenPath(filePath) {
  const p = String(filePath);
  return LIMITS.forbiddenFilePatterns.some(re => re.test(p));
}

function isForbiddenAction(action) {
  return LIMITS.forbiddenActions.includes(action);
}

function checkLimit(name, currentValue) {
  const limit = LIMITS[name];
  if (limit == null) return { ok: true };
  if (typeof limit === 'number' && currentValue >= limit) {
    return { ok: false, reason: `Limit hit: ${name} = ${currentValue}/${limit}` };
  }
  return { ok: true };
}

function audit(event, data = {}) {
  try {
    const dir = path.dirname(AUDIT_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...data,
    }) + '\n';

    fs.appendFileSync(AUDIT_PATH, entry);
  } catch (e) {
    console.error('[SafetyGuards] audit write failed:', e.message);
  }
}

function sanityCheck(proposal, context = {}) {
  // Ye har self-modification se pehle check hota hai
  const errors = [];

  if (!proposal || typeof proposal !== 'object') errors.push('invalid proposal');
  if (proposal.action && isForbiddenAction(proposal.action)) errors.push(`forbidden action: ${proposal.action}`);
  if (proposal.file && isForbiddenPath(proposal.file)) errors.push(`forbidden file: ${proposal.file}`);

  // Confidence threshold — AI ko 70%+ confidence chahiye
  if (proposal.confidence != null && proposal.confidence < 0.7) {
    errors.push(`low confidence: ${proposal.confidence}`);
  }

  audit('sanityCheck', { proposal: proposal.action || 'unknown', errors });
  return { ok: errors.length === 0, errors };
}

module.exports = {
  LIMITS,
  isForbiddenPath,
  isForbiddenAction,
  checkLimit,
  audit,
  sanityCheck,
};

