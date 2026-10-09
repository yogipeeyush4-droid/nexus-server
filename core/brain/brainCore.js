// core/brain/brainCore.js — NEXUS Deep Thinker (v5.0)
// Self-learning, self-critiquing, self-evolving AI Brain
'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const llm = require('../llmGateway');
const knowledge = require('./knowledgeGraph');
const goals = require('./goalEngine');
const strategies = require('./strategyEngine');
const reflection = require('./reflectionEngine');
const codeAdvisor = require('./codeAdvisor');
const taskAgent = require('../../agents/taskAgent');

/* ================================================================== */
/*  CONFIG                                                             */
/* ================================================================== */
const CONFIG = Object.freeze({
  version: '5.0.0',
  maxInputLength: 12000,
  maxThoughts: 300,
  maxHistoryItems: 10,
  maxMemoryHits: 5,
  maxRecalledChars: 12000,
  maxGoalCount: 5,
  memoryTimeoutMs: 8000,
  llmTimeoutMs: 45000,
  taskTimeoutMs: 60000,
  reflectionTimeoutMs: 10000,
  critiqueTimeoutMs: 15000,
  deliberationTimeoutMs: 20000,
  defaultTemperature: 0.7,
  defaultMaxTokens: 1000,
  saveSuccessfulExperiences: true,
  maxStoredInputChars: 300,
  maxStoredReplyChars: 500,

  // persistence / learning
  persistPath: process.env.NEXUS_STATE_PATH || null,
  persistDebounceMs: 2000,
  learningRate: 0.15,
  minSamplesForAdapt: 3,
  explorationRate: 0.08,

  // v5 — deep thinking
  enableDeliberation: true,
  enableSelfCritique: true,
  enablePrediction: true,
  enableSelfEvolution: true,
  selfEvolveIntervalMs: 5 * 60_000,
  consolidationIntervalMs: 10 * 60_000,

  // confidence thresholds
  confidence: Object.freeze({
    lowThreshold: 0.4,      // below this → warn + refine
    refineThreshold: 0.55,  // below this + complex → run critique
    highThreshold: 0.8,
  }),

  // critique
  critique: Object.freeze({
    minLengthToCritique: 60,
    genericPhrases: [
      'i cannot', 'i am unable', 'as an ai', 'i apologize',
      'main nahi kar sakta', 'mujhe nahi pata', 'sorry, i can\'t',
      'as a language model', 'i don\'t have access',
    ],
    minAcceptableScore: 0.55,
  }),

  // consolidation
  consolidation: Object.freeze({
    similarityThreshold: 0.82,   // Jaccard above this → merge
    decayHalfLifeDays: 30,       // importance halves every N days idle
    minImportance: 0.05,
  }),

  circuitBreaker: Object.freeze({
    failureThreshold: 5,
    cooldownMs: 30_000,
  }),
  failureMemorySize: 100,
  autoTuneIntervalMs: 60_000,
});

const VALID_STRATEGIES = new Set([
  'direct_answer', 'web_search', 'knowledge_lookup', 'reflect_then_act', 'tool_chain',
]);

/* ================================================================== */
/*  LOGGER                                                             */
/* ================================================================== */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
class Logger {
  constructor(level = process.env.NEXUS_LOG_LEVEL || 'info') {
    this.level = LEVELS[level] ?? LEVELS.info;
  }
  _w(l, m, meta) {
    if (LEVELS[l] < this.level) return;
    const sink = l === 'error' ? console.error : l === 'warn' ? console.warn : console.log;
    meta === undefined ? sink(`[Brain][${l.toUpperCase()}] ${m}`)
                       : sink(`[Brain][${l.toUpperCase()}] ${m}`, meta);
  }
  debug(m, x) { this._w('debug', m, x); }
  info(m, x)  { this._w('info', m, x); }
  warn(m, x)  { this._w('warn', m, x); }
  error(m, x) { this._w('error', m, x); }
}

/* ================================================================== */
/*  TEXT UTILS                                                         */
/* ================================================================== */
function tokenize(t) {
  const m = String(t).toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return new Set(m || []);
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let i = 0;
  for (const t of a) if (b.has(t)) i++;
  return i / (a.size + b.size - i);
}

/* ================================================================== */
/*  CIRCUIT BREAKER                                                    */
/* ================================================================== */
class CircuitBreaker {
  constructor(name, { failureThreshold, cooldownMs }, logger) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.logger = logger;
    this.failures = 0;
    this.state = 'closed';
    this.openedAt = 0;
  }
  canPass() {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half-open';
        this.logger.info(`Circuit ${this.name} → half-open`);
        return true;
      }
      return false;
    }
    return true;
  }
  onSuccess() {
    if (this.state !== 'closed') this.logger.info(`Circuit ${this.name} → closed`);
    this.failures = 0;
    this.state = 'closed';
  }
  onFailure() {
    this.failures++;
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
      this.logger.warn(`Circuit ${this.name} → OPEN (${this.failures} failures)`);
    }
  }
  snapshot() { return { name: this.name, state: this.state, failures: this.failures }; }
}

/* ================================================================== */
/*  STRATEGY LEARNER (unchanged core, richer stats)                    */
/* ================================================================== */
class StrategyLearner {
  constructor({ learningRate, minSamples, explorationRate }) {
    this.lr = learningRate;
    this.minSamples = minSamples;
    this.explore = explorationRate;
    this.scores = Object.create(null); // strategy -> { wins, total, avgLatency, avgConfidence, critiques }
  }
  record(strategy, { success, latencyMs, confidence = null, critiqued = false }) {
    if (!this.scores[strategy]) {
      this.scores[strategy] = { wins: 0, total: 0, avgLatency: 0, avgConfidence: 0.5, critiques: 0 };
    }
    const s = this.scores[strategy];
    s.total++;
    if (success) s.wins++;
    s.avgLatency = s.avgLatency === 0
      ? latencyMs
      : s.avgLatency * (1 - this.lr) + latencyMs * this.lr;
    if (confidence !== null) {
      s.avgConfidence = s.avgConfidence === 0.5
        ? confidence
        : s.avgConfidence * (1 - this.lr) + confidence * this.lr;
    }
    if (critiqued) s.critiques++;
  }
  successRate(strategy) {
    const s = this.scores[strategy];
    if (!s || s.total < this.minSamples) return null;
    return s.wins / s.total;
  }
  pick(candidates) {
    if (!candidates.length) return null;
    if (Math.random() < this.explore) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
    let best = candidates[0], bestScore = -Infinity;
    for (const c of candidates) {
      const rate = this.successRate(c);
      const s = this.scores[c];
      const latPenalty = s ? Math.min(0.3, s.avgLatency / 60000) : 0;
      const confBoost = s ? (s.avgConfidence - 0.5) * 0.2 : 0;
      const score = (rate ?? 0.5) + confBoost - latPenalty;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }
  snapshot() { return JSON.parse(JSON.stringify(this.scores)); }
  restore(d) { if (d) this.scores = d; }
}

/* ================================================================== */
/*  FAILURE MEMORY                                                     */
/* ================================================================== */
class FailureMemory {
  constructor(max) { this.max = max; this.entries = []; }
  add(signature, meta) {
    this.entries.push({ signature, ts: Date.now(), ...meta });
    if (this.entries.length > this.max) this.entries.shift();
  }
  recentSignature(sig, withinMs = 5 * 60_000) {
    const cutoff = Date.now() - withinMs;
    return this.entries.find(e => e.signature === sig && e.ts >= cutoff);
  }
  topSignatures(n = 5) {
    const counts = new Map();
    for (const e of this.entries) counts.set(e.signature, (counts.get(e.signature) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  }
  snapshot() { return this.entries.slice(-20); }
  restore(arr) { if (Array.isArray(arr)) this.entries = arr.slice(-this.max); }
}

/* ================================================================== */
/*  🎯 CONFIDENCE SCORER  (NEW)                                        */
/* ================================================================== */
class ConfidenceScorer {
  /** Estimate confidence in [0,1] from multiple signals. */
  static estimate({ memoryCount, memoryTopScore, strategy, learner, reply, hasCritique }) {
    let score = 0.5; // neutral base

    // Signal 1: memory hits
    if (memoryCount > 0) {
      score += Math.min(0.2, memoryCount * 0.05);
      if (memoryTopScore !== null && memoryTopScore > 0.8) score += 0.1;
    } else {
      score -= 0.05;
    }

    // Signal 2: strategy history
    const rate = learner.successRate(strategy);
    if (rate !== null) score += (rate - 0.5) * 0.3;

    // Signal 3: reply quality heuristics
    if (typeof reply === 'string' && reply.length > 0) {
      if (reply.length < 30) score -= 0.1;
      const uncertain = /\b(maybe|perhaps|might|not sure|shayad|pata nahi|uncertain)\b/i.test(reply);
      if (uncertain) score -= 0.15;
      const refuses = /\b(i cannot|i am unable|as an ai|main nahi kar sakta)\b/i.test(reply);
      if (refuses) score -= 0.2;
      if (/\b(definitely|certainly|clearly|confirmed|pakka)\b/i.test(reply)) score += 0.05;
    } else {
      score -= 0.3;
    }

    // Signal 4: prior critique
    if (hasCritique) score += 0.05;

    return Math.max(0, Math.min(1, Number(score.toFixed(3))));
  }
}

/* ================================================================== */
/*  🔬 SELF-CRITIC  (NEW)                                              */
/* ================================================================== */
class SelfCritic {
  constructor(logger, cfg) { this.logger = logger; this.cfg = cfg; }

  /** Quick heuristic score for reply quality (0..1). */
  heuristicScore(reply, message, memories) {
    if (!reply || typeof reply !== 'string') return 0;
    let s = 0.5;
    const len = reply.length;

    if (len < 30) s -= 0.2;
    else if (len > 80) s += 0.1;
    if (len > 800) s += 0.05;

    const lower = reply.toLowerCase();
    for (const p of this.cfg.genericPhrases) if (lower.includes(p)) s -= 0.15;

    // Did it address the question? Rough: shares tokens
    const q = tokenize(message);
    const a = tokenize(reply);
    const overlap = jaccard(q, a);
    if (overlap > 0.15) s += 0.15;
    else if (overlap < 0.03) s -= 0.1;

    // Memory acknowledgement bonus
    if (memories.length && memories.some(m => lower.includes(m.content.slice(0, 15).toLowerCase()))) {
      s += 0.1;
    }
    return Math.max(0, Math.min(1, s));
  }

  /** If reply looks weak and query is complex, ask LLM to refine it. */
  async critique({ message, reply, memories, strategy, llmFn, timeoutMs }) {
    const baseScore = this.heuristicScore(reply, message, memories);
    if (baseScore >= this.cfg.minAcceptableScore) {
      return { refined: false, score: baseScore, reply };
    }
    this.logger.debug('Running self-critique refine', { baseScore, strategy });

    const critiquePrompt = [
      'Aap NEXUS ke internal self-critic ho. Neeche user query aur draft reply hai.',
      'Agar draft weak, generic, ya sawal ko address nahi kar raha to behtar reply likho.',
      'Agar theek hai to usi ko thoda crisp karke wapas do.',
      'STRICT: Sirf final reply text return karo — koi explanation, koi meta-commentary nahi.',
      '',
      `USER QUERY: ${message}`,
      memories.length ? `MEMORY:\n${memories.map(m => '- ' + m.content).join('\n')}` : '',
      `DRAFT REPLY: ${reply}`,
      '',
      'Better reply:',
    ].filter(Boolean).join('\n');

    try {
      const out = await llmFn(critiquePrompt, { temperature: 0.4, maxTokens: 800 });
      const refined = typeof out === 'string' ? out.trim()
        : (out && typeof out.reply === 'string' ? out.reply.trim() : '');
      if (!refined) return { refined: false, score: baseScore, reply };

      const newScore = this.heuristicScore(refined, message, memories);
      if (newScore > baseScore) {
        return { refined: true, score: newScore, reply: refined };
      }
      return { refined: false, score: baseScore, reply };
    } catch (err) {
      this.logger.warn('Critique failed', { err: err.message });
      return { refined: false, score: baseScore, reply };
    }
  }
}

/* ================================================================== */
/*  💭 DELIBERATOR (NEW) — think before speaking on complex tasks      */
/* ================================================================== */
class Deliberator {
  constructor(logger) { this.logger = logger; }

  /** Returns { plan: string[], subQuestions: string[], brief: string } */
  async deliberate({ message, memories, strategy, llmFn, timeoutMs }) {
    const prompt = [
      'You are NEXUS internal deliberation module.',
      'Before answering the user, produce a SHORT internal plan.',
      'Return ONLY valid JSON, no markdown:',
      '{"plan":["step1","step2"],"subQuestions":["q1"],"brief":"one-line intent summary"}',
      '',
      `USER MESSAGE: ${message}`,
      `STRATEGY: ${strategy}`,
      memories.length ? `MEMORIES:\n${memories.map(m => '- ' + m.content.slice(0, 200)).join('\n')}` : 'No memories.',
    ].join('\n');

    try {
      const raw = await llmFn(prompt, { temperature: 0.3, maxTokens: 400 });
      const text = typeof raw === 'string' ? raw
        : (raw && typeof raw.reply === 'string' ? raw.reply : '');
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { plan: [], subQuestions: [], brief: '' };
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        plan: Array.isArray(parsed.plan) ? parsed.plan.slice(0, 6).map(String) : [],
        subQuestions: Array.isArray(parsed.subQuestions) ? parsed.subQuestions.slice(0, 5).map(String) : [],
        brief: typeof parsed.brief === 'string' ? parsed.brief.slice(0, 200) : '',
      };
    } catch (err) {
      this.logger.debug('Deliberation skipped', { err: err.message });
      return { plan: [], subQuestions: [], brief: '' };
    }
  }
}

/* ================================================================== */
/*  🧬 MEMORY CONSOLIDATOR (NEW)                                       */
/* ================================================================== */
class MemoryConsolidator {
  constructor({ similarityThreshold, decayHalfLifeDays, minImportance }, logger) {
    this.simThreshold = similarityThreshold;
    this.halfLifeMs = decayHalfLifeDays * 24 * 60 * 60 * 1000;
    this.minImportance = minImportance;
    this.logger = logger;
    this.importance = new Map(); // nodeId -> { score, lastSeen }
    this.lastConsolidation = 0;
  }

  /** Bump importance when memory is reused. */
  touch(nodeId, weight = 1) {
    if (!nodeId) return;
    const cur = this.importance.get(nodeId) || { score: 1, lastSeen: Date.now() };
    cur.score = Math.min(10, cur.score + weight * 0.3);
    cur.lastSeen = Date.now();
    this.importance.set(nodeId, cur);
  }

  /** Decay all importances by elapsed time. */
  decay() {
    const now = Date.now();
    for (const [id, v] of this.importance) {
      const elapsed = now - v.lastSeen;
      const factor = Math.pow(0.5, elapsed / this.halfLifeMs);
      v.score = v.score * factor;
      if (v.score < this.minImportance) this.importance.delete(id);
      else this.importance.set(id, v);
    }
  }

  /** Find near-duplicate memories in a candidate list (client-side merge hint). */
  findDuplicates(memories) {
    const dups = [];
    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const sim = jaccard(tokenize(memories[i].content), tokenize(memories[j].content));
        if (sim >= this.simThreshold) dups.push({ i, j, sim });
      }
    }
    return dups;
  }

  importanceOf(nodeId) { return this.importance.get(nodeId)?.score ?? 1; }

  snapshot() {
    return [...this.importance.entries()].slice(-100).map(([id, v]) => ({ id, ...v }));
  }
  restore(arr) {
    if (!Array.isArray(arr)) return;
    this.importance = new Map(arr.map(e => [e.id, { score: e.score, lastSeen: e.lastSeen }]));
  }
}

/* ================================================================== */
/*  ⛏️ INSIGHT MINER (NEW)                                             */
/* ================================================================== */
class InsightMiner {
  constructor(logger) { this.logger = logger; }

  /** Look at recent thoughts and produce qualitative observations. */
  mine(thoughts, failures, learner) {
    const insights = [];

    // 1. Latency trend
    const latencies = thoughts.filter(t => t.stage === 'output' && t.latencyMs).map(t => t.latencyMs);
    if (latencies.length >= 5) {
      const recent = latencies.slice(-5);
      const older = latencies.slice(-10, -5);
      if (older.length) {
        const rAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
        const oAvg = older.reduce((a, b) => a + b, 0) / older.length;
        if (rAvg > oAvg * 1.3) insights.push({ type: 'latency_worse', severity: 'warn', detail: `Recent avg ${Math.round(rAvg)}ms vs prior ${Math.round(oAvg)}ms` });
        else if (rAvg < oAvg * 0.8) insights.push({ type: 'latency_better', severity: 'info', detail: `Improved: ${Math.round(rAvg)}ms` });
      }
    }

    // 2. Failure clustering
    const topFails = failures.topSignatures(3);
    if (topFails.length && topFails[0][1] >= 3) {
      insights.push({
        type: 'recurring_failure',
        severity: 'warn',
        detail: `"${topFails[0][0]}" occurred ${topFails[0][1]} times recently`,
      });
    }

    // 3. Weak strategies
    for (const [s, v] of Object.entries(learner.scores)) {
      if (v.total >= 5 && v.wins / v.total < 0.5) {
        insights.push({
          type: 'weak_strategy',
          severity: 'warn',
          detail: `${s} success only ${Math.round((v.wins / v.total) * 100)}% (${v.wins}/${v.total})`,
        });
      }
      if (v.critiques >= 3 && v.critiques / v.total > 0.5) {
        insights.push({
          type: 'frequent_critique',
          severity: 'warn',
          detail: `${s} needs critique ${v.critiques}/${v.total} times`,
        });
      }
    }

    // 4. Confidence trend
    const confs = thoughts.filter(t => t.stage === 'output' && typeof t.confidence === 'number').map(t => t.confidence);
    if (confs.length >= 5) {
      const avg = confs.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, confs.length);
      if (avg < 0.5) insights.push({ type: 'low_confidence', severity: 'warn', detail: `Recent avg confidence ${(avg * 100).toFixed(0)}%` });
    }

    return insights;
  }
}

/* ================================================================== */
/*  🎭 PERSONA STATE (NEW) — lightweight brain "mood"                  */
/* ================================================================== */
class PersonaState {
  constructor() {
    this.energy = 1.0;      // 0..1
    this.confidenceBias = 0; // -0.1..+0.1
    this.lastUpdate = Date.now();
  }
  pulse({ success, latencyMs, confidence }) {
    // Energy ebbs with latency and failures, rises with successes
    const latFactor = Math.max(0, 1 - latencyMs / 45000);
    const delta = (success ? +0.05 : -0.08) + (confidence - 0.5) * 0.05 + latFactor * 0.02;
    this.energy = Math.max(0.3, Math.min(1.2, this.energy + delta));

    this.confidenceBias = (this.energy - 1) * 0.1;
    this.lastUpdate = Date.now();
  }
  styleHint() {
    if (this.energy > 1.05) return 'energetic and crisp';
    if (this.energy < 0.6) return 'calm and focused';
    return 'balanced';
  }
  snapshot() { return { energy: +this.energy.toFixed(3), confidenceBias: +this.confidenceBias.toFixed(3) }; }
  restore(s) {
    if (!s) return;
    this.energy = s.energy ?? 1.0;
    this.confidenceBias = s.confidenceBias ?? 0;
  }
}

/* ================================================================== */
/*  MAIN CLASS                                                         */
/* ================================================================== */
class BrainCore extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    this.logger = new Logger();
    this.thoughts = [];
    this.maxThoughts = CONFIG.maxThoughts;
    this.startedAt = Date.now();
    this.processingCount = 0;
    this.stats = {
      requests: 0, succeeded: 0, failed: 0,
      memoryFailures: 0, taskFailures: 0, llmFailures: 0, reflectionFailures: 0,
      memoryWrites: 0, circuitRejections: 0, exploration: 0,
      deliberations: 0, critiques: 0, refinements: 0, lowConfidence: 0,
      predictions: 0,
    };

    this.learner = new StrategyLearner({
      learningRate: CONFIG.learningRate,
      minSamples: CONFIG.minSamplesForAdapt,
      explorationRate: CONFIG.explorationRate,
    });
    this.failureMemory = new FailureMemory(CONFIG.failureMemorySize);
    this.consolidator = new MemoryConsolidator(CONFIG.consolidation, this.logger);
    this.critic = new SelfCritic(this.logger, CONFIG.critique);
    this.deliberator = new Deliberator(this.logger);
    this.insightMiner = new InsightMiner(this.logger);
    this.persona = new PersonaState();
    this.latencyWindow = [];

    const cb = CONFIG.circuitBreaker;
    this.breakers = {
      llm: new CircuitBreaker('llm', cb, this.logger),
      task: new CircuitBreaker('task', cb, this.logger),
      knowledge: new CircuitBreaker('knowledge', cb, this.logger),
      reflection: new CircuitBreaker('reflection', cb, this.logger),
    };

    this._persistTimer = null;
    this._loadState();
    this._registerDefaultStrategies();

    this._tuneTimer = setInterval(() => this._autoTune(), CONFIG.autoTuneIntervalMs);
    if (this._tuneTimer.unref) this._tuneTimer.unref();

    if (CONFIG.enableSelfEvolution) {
      this._evolveTimer = setInterval(() => this._selfEvolve(), CONFIG.selfEvolveIntervalMs);
      if (this._evolveTimer.unref) this._evolveTimer.unref();
    }
    this._consolidateTimer = setInterval(() => this._consolidate(), CONFIG.consolidationIntervalMs);
    if (this._consolidateTimer.unref) this._consolidateTimer.unref();
  }

  /* ---------------- persistence ---------------- */
  _loadState() {
    if (!CONFIG.persistPath) return;
    try {
      if (!fs.existsSync(CONFIG.persistPath)) return;
      const data = JSON.parse(fs.readFileSync(CONFIG.persistPath, 'utf8'));
      this.learner.restore(data.learner);
      this.failureMemory.restore(data.failureMemory);
      this.consolidator.restore(data.consolidator);
      this.persona.restore(data.persona);
      this.logger.info('Brain state restored');
    } catch (err) {
      this.logger.warn('Failed to load state', { err: err.message });
    }
  }
  _schedulePersist() {
    if (!CONFIG.persistPath || this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persistNow();
    }, CONFIG.persistDebounceMs);
    if (this._persistTimer.unref) this._persistTimer.unref();
  }
  _persistNow() {
    if (!CONFIG.persistPath) return;
    try {
      const dir = path.dirname(CONFIG.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG.persistPath, JSON.stringify({
        version: CONFIG.version,
        savedAt: Date.now(),
        learner: this.learner.snapshot(),
        failureMemory: this.failureMemory.snapshot(),
        consolidator: this.consolidator.snapshot(),
        persona: this.persona.snapshot(),
      }, null, 2), 'utf8');
    } catch (err) {
      this.logger.warn('Persist failed', { err: err.message });
    }
  }

  /* ---------------- strategy registration ---------------- */
  _registerDefaultStrategies() {
    if (!strategies || typeof strategies.register !== 'function') return;
    const defs = [
      ['direct_answer',    { category: 'chat',      description: 'Answer user questions' }],
      ['web_search',       { category: 'live_data', description: 'Search current information' }],
      ['knowledge_lookup', { category: 'recall',    description: 'Use relevant memories' }],
      ['reflect_then_act', { category: 'complex',   description: 'Handle multi-step requests' }],
      ['tool_chain',       { category: 'tools',     description: 'Execute a tool task' }],
    ];
    for (const [n, d] of defs) {
      try { strategies.register(n, d); }
      catch (err) { this.logger.debug(`Strategy registration skipped: ${n}`, { err: err.message }); }
    }
  }

  /* ---------------- utilities ---------------- */
  async _withTimeout(op, ms, label) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(op),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  _safeEmit(ev, p) {
    try { this.emit(ev, p); }
    catch (err) { this.logger.error(`Listener failed for ${ev}`, { err: err.message }); }
  }
  _think(step) {
    const entry = { ts: Date.now(), ...step };
    this.thoughts.push(entry);
    if (this.thoughts.length > this.maxThoughts) this.thoughts.shift();
    this._safeEmit('thought', entry);
  }
  _cleanInput(v) {
    if (typeof v !== 'string') return { ok: false, error: 'Message must be a string.' };
    const m = v.replace(/\s+/g, ' ').trim();
    if (!m) return { ok: false, error: 'Message cannot be empty.' };
    if (m.length > CONFIG.maxInputLength) return { ok: false, error: `Message exceeds ${CONFIG.maxInputLength} characters.` };
    return { ok: true, value: m };
  }
  _normalizeOptions(o) {
    const s = o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    const t = Number(s.temperature), mt = Number(s.maxTokens);
    return {
      temperature: Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : CONFIG.defaultTemperature,
      maxTokens: Number.isFinite(mt) ? Math.min(4000, Math.max(1, Math.floor(mt))) : CONFIG.defaultMaxTokens,
      userId: typeof s.userId === 'string' ? s.userId.slice(0, 128) : 'default',
      conversationId: typeof s.conversationId === 'string' ? s.conversationId.slice(0, 128) : null,
      correlationId: typeof s.correlationId === 'string' ? s.correlationId.slice(0, 128) : null,
      saveMemory: s.saveMemory !== false,
      forceStrategy: VALID_STRATEGIES.has(s.strategy) ? s.strategy : null,
      history: Array.isArray(s.history)
        ? s.history.slice(-CONFIG.maxHistoryItems)
            .filter(i => i && ['user', 'assistant'].includes(i.role) && typeof i.content === 'string')
            .map(i => ({ role: i.role, content: i.content.slice(0, 2000) }))
        : [],
    };
  }

  /* ---------------- memory ---------------- */
  async _retrieveMemories(message) {
    if (!knowledge || typeof knowledge.search !== 'function') {
      return { memories: [], warning: 'Memory search is unavailable.' };
    }
    if (!this.breakers.knowledge.canPass()) {
      this.stats.circuitRejections++;
      return { memories: [], warning: 'Memory circuit open.' };
    }
    try {
      const result = await this._withTimeout(
        () => knowledge.search(message, CONFIG.maxMemoryHits),
        CONFIG.memoryTimeoutMs, 'Memory search'
      );
      this.breakers.knowledge.onSuccess();

      // Consolidator-based dedupe + importance sort
      const raw = (Array.isArray(result) ? result : [])
        .filter(i => i && typeof i.content === 'string' && i.content.trim())
        .map(i => ({
          content: i.content.trim().slice(0, 3000),
          score: Number.isFinite(Number(i.score)) ? Number(i.score) : null,
          id: i.id ?? null,
        }));

      const dups = this.consolidator.findDuplicates(raw);
      const drop = new Set(dups.map(d => d.j));
      const memories = raw
        .filter((_, idx) => !drop.has(idx))
        .map(m => ({
          ...m,
          importance: this.consolidator.importanceOf(m.id),
        }))
        .sort((a, b) => (b.score ?? 0) * 0.7 + b.importance * 0.3 - ((a.score ?? 0) * 0.7 + a.importance * 0.3))
        .slice(0, CONFIG.maxMemoryHits);

      // Touch importance for recalled memories
      for (const m of memories) this.consolidator.touch(m.id, 0.5);

      return { memories, warning: null };
    } catch (err) {
      this.breakers.knowledge.onFailure();
      this.stats.memoryFailures++;
      this.logger.warn('Memory search failed', { err: err.message });
      return { memories: [], warning: 'Memory retrieval failed; continuing without memories.' };
    }
  }

  /* ---------------- intent / strategy ---------------- */
  _classifyIntentDynamically(message, memories) {
    const text = message.toLowerCase();
    if (/\b(latest|today|current|news|weather|price|search the web|web search)\b/i.test(text) ||
        /आज की खबर|ताजा जानकारी|अभी का भाव|वेब सर्च/i.test(text)) return 'live_data';
    if (/\b(remember|recall|what did i say|do you remember|kya tum yaad|sikh|seekh)\b/i.test(text) ||
        /याद रख|याद है|पहले क्या कहा|सीख/i.test(text)) return 'recall';
    if (/\b(build|create|implement|debug|fix|refactor|multi-step|plan|upgrade|analyze|analyse)\b/i.test(text) ||
        /बनाओ|ठीक करो|डिबग|योजना बनाओ|अपग्रेड|विश्लेषण/i.test(text) ||
        message.length > 500) return 'complex';
    if (memories.length > 0) return 'recall';
    return 'chat';
  }
  _chooseStrategy(category, options) {
    const fallback = { chat: 'direct_answer', live_data: 'web_search', recall: 'knowledge_lookup', complex: 'reflect_then_act', tools: 'tool_chain' };
    if (options.forceStrategy) return options.forceStrategy;
    let enginePick = null;
    try {
      if (strategies && typeof strategies.pick === 'function') {
        const s = strategies.pick(category);
        if (typeof s === 'string' && VALID_STRATEGIES.has(s)) enginePick = s;
      }
    } catch (err) { this.logger.warn('Strategy engine pick failed', { err: err.message }); }

    const categoryDefault = fallback[category] || 'direct_answer';
    const candidates = new Set([categoryDefault]);
    if (enginePick) candidates.add(enginePick);
    for (const s of Object.keys(this.learner.scores)) if (VALID_STRATEGIES.has(s)) candidates.add(s);
    return this.learner.pick([...candidates]) || categoryDefault;
  }

  _buildContext(message, memories, strategy, options, deliberation) {
    let goalsSnapshot = [], reflectionSummary = {};
    try {
      if (goals && typeof goals.prioritized === 'function') goalsSnapshot = goals.prioritized(CONFIG.maxGoalCount) || [];
    } catch (err) { this.logger.warn('Goal retrieval failed', { err: err.message }); }
    try {
      if (reflection && typeof reflection.summary === 'function') reflectionSummary = reflection.summary(20) || {};
    } catch (err) { this.logger.warn('Reflection summary failed', { err: err.message }); }

    const recalled = memories.map(i => i.content).join('\n');
    return {
      userMessage: message,
      recalled: recalled.slice(0, CONFIG.maxRecalledChars),
      memories, strategy, goalsSnapshot, reflectionSummary,
      history: options.history,
      userId: options.userId,
      conversationId: options.conversationId,
      deliberation,
    };
  }

  /* ---------------- LLM helper ---------------- */
  async _llmAsk(prompt, opts, timeoutMs = CONFIG.llmTimeoutMs) {
    if (!llm || typeof llm.ask !== 'function') throw new Error('LLM gateway is unavailable.');
    return this._withTimeout(() => llm.ask(prompt, opts), timeoutMs, 'LLM');
  }

  /* ---------------- execution ---------------- */
  async _executeStrategy(strategy, context, options, correlationId) {
    if (['web_search', 'tool_chain'].includes(strategy)) {
      if (!taskAgent || typeof taskAgent.execute !== 'function') throw new Error('TaskAgent is unavailable.');
      if (!this.breakers.task.canPass()) { this.stats.circuitRejections++; throw new Error('Task circuit is open.'); }
      try {
        const result = await this._withTimeout(
          () => taskAgent.execute(context.userMessage, {
            userId: options.userId, conversationId: options.conversationId, correlationId,
          }),
          CONFIG.taskTimeoutMs, 'Task execution'
        );
        if (!result || typeof result !== 'object') throw new Error('TaskAgent returned invalid response.');
        if (result.error) { this.stats.taskFailures++; throw new Error(String(result.error).slice(0, 500)); }
        const reply = (typeof result.managerReply === 'string' && result.managerReply.trim()) ||
                      (typeof result.reply === 'string' && result.reply.trim());
        if (!reply) throw new Error('TaskAgent returned no usable reply.');
        this.breakers.task.onSuccess();
        return reply;
      } catch (err) { this.breakers.task.onFailure(); throw err; }
    }

    if (!llm || typeof llm.ask !== 'function') throw new Error('LLM gateway is unavailable.');
    if (!this.breakers.llm.canPass()) { this.stats.circuitRejections++; throw new Error('LLM circuit is open.'); }

    const goalTitles = context.goalsSnapshot
      .map(g => (g && typeof g.title === 'string' ? g.title : null))
      .filter(Boolean).slice(0, CONFIG.maxGoalCount);

    const deliberationBlock = context.deliberation && context.deliberation.plan?.length
      ? `Internal plan (follow this logic):\n${context.deliberation.plan.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : '';

    const system = [
      'You are Nexus, a fully autonomous, self-learning, self-critiquing AI Brain.',
      `Brain state: ${this.persona.styleHint()}.`,
      'CORE RULES:',
      '1. You have continuous long-term memory (Pinecone-backed Knowledge Graph). Never claim a knowledge cutoff or reset memory.',
      '2. Carefully use retrieved memories. Confirm you learn and remember.',
      '3. When user teaches or upgrades you, adapt and reflect it in behavior.',
      '4. Reply naturally, confidently, smartly in Hinglish unless asked otherwise.',
      `Current strategy: ${strategy}.`,
      `Active goals: ${goalTitles.join(' | ') || 'Continuous self-evolution.'}`,
      context.recalled ? `Retrieved memories:\n${context.recalled}` : 'No prior memory for this input — reason dynamically.',
      deliberationBlock,
      'Do not use generic assistant disclaimers. Be decisive and helpful.',
    ].filter(Boolean).join('\n');

    try {
      const result = await this._withTimeout(
        () => llm.ask(context.userMessage, { system, temperature: options.temperature, maxTokens: options.maxTokens }),
        CONFIG.llmTimeoutMs, 'LLM request'
      );
      const reply = typeof result === 'string' ? result : (result && typeof result.reply === 'string' ? result.reply : '');
      if (!reply.trim()) throw new Error('LLM returned empty response.');
      this.breakers.llm.onSuccess();
      return reply.trim();
    } catch (err) { this.breakers.llm.onFailure(); this.stats.llmFailures++; throw err; }
  }

  /* ---------------- reflection ---------------- */
  async _reflectSafely(data) {
    if (!reflection || typeof reflection.reflect !== 'function') return { insights: [], lessons: [], warning: 'Reflection engine unavailable.' };
    if (!this.breakers.reflection.canPass()) return { insights: [], lessons: [], warning: 'Reflection circuit open.' };
    try {
      const result = await this._withTimeout(() => reflection.reflect(data), CONFIG.reflectionTimeoutMs, 'Reflection');
      this.breakers.reflection.onSuccess();
      return {
        insights: Array.isArray(result?.insights) ? result.insights : [],
        lessons: Array.isArray(result?.lessons) ? result.lessons : [],
        warning: null,
      };
    } catch (err) {
      this.breakers.reflection.onFailure();
      this.stats.reflectionFailures++;
      this.logger.warn('Reflection failed', { err: err.message });
      return { insights: [], lessons: [], warning: 'Reflection failed.' };
    }
  }

  /* ---------------- experience saving ---------------- */
  async _saveExperience(message, reply, strategy, options, latencyMs, confidence) {
    if (!CONFIG.saveSuccessfulExperiences || !options.saveMemory ||
        !knowledge || typeof knowledge.addNode !== 'function') {
      return { saved: false, reason: 'Memory saving disabled or unavailable.' };
    }
    if (message.length < 5 || reply.length < 5) return { saved: false, reason: 'Too short to store.' };

    const content = [
      `User request: ${message.slice(0, CONFIG.maxStoredInputChars)}`,
      `Assistant response: ${reply.slice(0, CONFIG.maxStoredReplyChars)}`,
    ].join('\n');

    try {
      const saved = await this._withTimeout(
        () => knowledge.addNode({
          type: 'autonomous_experience',
          content,
          tags: ['nexus', 'self_learned', strategy],
          weight: 1,
          metadata: {
            strategy, latencyMs, confidence,
            timestamp: Date.now(), userId: options.userId, conversationId: options.conversationId,
          },
        }),
        CONFIG.memoryTimeoutMs, 'Experience storage'
      );
      this.stats.memoryWrites++;
      this._schedulePersist();
      return { saved: true, nodeId: saved?.id ?? null };
    } catch (err) {
      this.stats.memoryFailures++;
      this.logger.warn('Experience storage failed', { err: err.message });
      return { saved: false, reason: 'Memory storage failed.' };
    }
  }

  /* ---------------- adaptation ---------------- */
  _recordOutcome(strategy, { success, latencyMs, errorSignature, correlationId, confidence, critiqued }) {
    this.learner.record(strategy, { success, latencyMs, confidence, critiqued });
    this.latencyWindow.push(latencyMs);
    if (this.latencyWindow.length > 500) this.latencyWindow.shift();
    if (!success && errorSignature) this.failureMemory.add(errorSignature, { strategy, latencyMs, correlationId });
    this.persona.pulse({ success, latencyMs, confidence: confidence ?? 0.5 });

    this._think({
      stage: 'adaptation', strategy, success, latencyMs, confidence,
      strategyStats: this.learner.scores[strategy] || null,
      persona: this.persona.snapshot(),
    });
    this._safeEmit('adaptation', { strategy, success, latencyMs, confidence, correlationId });
    this._schedulePersist();
  }

  _autoTune() {
    const w = this.latencyWindow;
    if (!w.length) return;
    const avg = w.reduce((a, b) => a + b, 0) / w.length;
    this._think({ stage: 'auto_tune', avgLatencyMs: Math.round(avg), samples: w.length });
    if (avg > 20000) this.logger.warn('High avg latency', { avgLatencyMs: Math.round(avg) });
  }

  /* ---------------- periodic tasks ---------------- */
  _consolidate() {
    try {
      this.consolidator.decay();
      this._think({ stage: 'consolidation', trackedMemories: this.consolidator.snapshot().length });
    } catch (err) { this.logger.warn('Consolidation failed', { err: err.message }); }
  }

  async _selfEvolve() {
    try {
      const insights = this.insightMiner.mine(this.thoughts, this.failureMemory, this.learner);
      if (insights.length) {
        this._think({ stage: 'self_evolve', insights });
        this._safeEmit('insights', insights);

        // Auto-create goals from serious insights
        if (goals && typeof goals.addGoal === 'function') {
          for (const ins of insights.filter(i => i.severity === 'warn').slice(0, 2)) {
            try {
              goals.addGoal({
                title: `Self-fix: ${ins.type}`,
                description: ins.detail,
                priority: 7,
                tags: ['self-evolve', 'auto'],
                source: 'brain-self-evolve',
              });
            } catch (e) { this.logger.debug('Auto-goal failed', { err: e.message }); }
          }
        }
      }
    } catch (err) {
      this.logger.warn('Self-evolution failed', { err: err.message });
    }
  }

  /* ================================================================ */
  /*  🧠 MAIN PIPELINE — THINK()                                       */
  /* ================================================================ */
  async think(userMessage, rawOptions = {}) {
    const start = Date.now();
    const correlationId = rawOptions.correlationId || crypto.randomUUID();
    this.stats.requests++;
    this.processingCount++;

    const normalized = this._cleanInput(userMessage);
    if (!normalized.ok) {
      this.processingCount--;
      return { ok: false, reply: normalized.error, strategy: 'none', latencyMs: Date.now() - start, warnings: [], correlationId, confidence: 0 };
    }
    const message = normalized.value;
    const options = this._normalizeOptions(rawOptions);

    this._think({ stage: 'input', messageLength: message.length, correlationId });

    let reply = '';
    let strategy = 'direct_answer';
    let success = false;
    let reflectionResult = { insights: [], lessons: [], warning: null };
    let memorySave = { saved: false, reason: 'Not attempted.' };
    let deliberation = { plan: [], subQuestions: [], brief: '' };
    let critiqueInfo = { refined: false, score: 0, reply: '' };
    let confidence = 0;
    const warnings = [];

    try {
      // 1. Recall
      const retrieval = await this._retrieveMemories(message);
      const memories = retrieval.memories;
      if (retrieval.warning) warnings.push(retrieval.warning);
      this._think({ stage: 'recall', hits: memories.length, correlationId });

      // 2. Intent + strategy
      const category = this._classifyIntentDynamically(message, memories);
      strategy = this._chooseStrategy(category, options);
      if (Math.random() < CONFIG.explorationRate) this.stats.exploration++;
      this._think({ stage: 'strategy', category, chosen: strategy, correlationId });

      // 3. Deliberate (only for complex/high-stakes)
      if (CONFIG.enableDeliberation && (category === 'complex' || message.length > 300) && this.breakers.llm.canPass()) {
        try {
          this.stats.deliberations++;
          deliberation = await this.deliberator.deliberate({
            message, memories, strategy,
            llmFn: (p, o) => this._llmAsk(p, o, CONFIG.deliberationTimeoutMs),
            timeoutMs: CONFIG.deliberationTimeoutMs,
          });
          this._think({ stage: 'deliberation', plan: deliberation.plan, subQ: deliberation.subQuestions, correlationId });
        } catch (e) { warnings.push('Deliberation skipped.'); }
      }

      // 4. Build context
      const context = this._buildContext(message, memories, strategy, options, deliberation);

      // 5. Execute
      let errorSignature = null;
      try {
        reply = await this._executeStrategy(strategy, context, options, correlationId);
        success = typeof reply === 'string' && reply.trim().length > 0;
      } catch (error) {
        errorSignature = `${strategy}:${error.message.slice(0, 80)}`;
        this.logger.warn('Execution failed', { strategy, err: error.message, correlationId });
        warnings.push(error.message);
        reply = 'Boss, task process karne mein error aaya: ' + error.message;
        success = false;
      }

      // 6. Self-critique (only if reply exists)
      if (success && CONFIG.enableSelfCritique && reply.length >= CONFIG.critique.minLengthToCritique && this.breakers.llm.canPass()) {
        try {
          this.stats.critiques++;
          critiqueInfo = await this.critic.critique({
            message, reply, memories, strategy,
            llmFn: (p, o) => this._llmAsk(p, o, CONFIG.critiqueTimeoutMs),
            timeoutMs: CONFIG.critiqueTimeoutMs,
          });
          if (critiqueInfo.refined) {
            this.stats.refinements++;
            this._think({ stage: 'critique_refined', oldScore: critiqueInfo.score, correlationId });
            reply = critiqueInfo.reply;
          } else {
            this._think({ stage: 'critique_passed', score: critiqueInfo.score, correlationId });
          }
        } catch (e) { warnings.push('Critique skipped.'); }
      }

      // 7. Confidence estimation
      confidence = ConfidenceScorer.estimate({
        memoryCount: memories.length,
        memoryTopScore: memories[0]?.score ?? null,
        strategy, learner: this.learner, reply,
        hasCritique: critiqueInfo.refined,
      });
      confidence = Math.max(0, Math.min(1, confidence + this.persona.confidenceBias));
      if (confidence < CONFIG.confidence.lowThreshold) this.stats.lowConfidence++;

      // 8. Reflect
      reflectionResult = await this._reflectSafely({
        action: strategy, input: message, output: reply,
        success, latencyMs: Date.now() - start, strategyName: strategy,
        confidence, deliberation: deliberation.plan,
      });
      if (reflectionResult.warning) warnings.push(reflectionResult.warning);

      // 9. Store experience
      if (success) {
        memorySave = await this._saveExperience(message, reply, strategy, options, Date.now() - start, confidence);
      }

      // 10. Learn
      this._recordOutcome(strategy, {
        success, latencyMs: Date.now() - start, errorSignature, correlationId,
        confidence, critiqued: critiqueInfo.refined,
      });

      // 11. Feed insights → goals
      this._feedInsightsToGoals(reflectionResult);

      // 12. Predict next (optional)
      let prediction = null;
      if (CONFIG.enablePrediction && success && memories.length) {
        prediction = this.predict(message, memories, options);
        this.stats.predictions++;
      }

      if (success) this.stats.succeeded++;
      else this.stats.failed++;

      this._think({
        stage: 'output', latencyMs: Date.now() - start,
        success, strategy, confidence, correlationId,
      });

      return {
        ok: success, reply, strategy,
        latencyMs: Date.now() - start,
        confidence,
        deliberation: { plan: deliberation.plan, brief: deliberation.brief },
        critique: { refined: critiqueInfo.refined, score: critiqueInfo.score },
        reflection: { insights: reflectionResult.insights, lessons: reflectionResult.lessons },
        recalledCount: memories.length,
        memorySaved: memorySave.saved,
        prediction,
        warnings,
        correlationId,
      };
    } catch (error) {
      this.stats.failed++;
      this.logger.error('Unexpected failure', { err: error.message, correlationId });
      this._think({ stage: 'error', message: error.message, correlationId });
      this._recordOutcome(strategy, {
        success: false, latencyMs: Date.now() - start,
        errorSignature: `unexpected:${error.message.slice(0, 80)}`,
        correlationId, confidence: 0, critiqued: false,
      });
      return {
        ok: false,
        reply: 'Boss, internal system error aaya: ' + error.message,
        strategy,
        latencyMs: Date.now() - start,
        confidence: 0,
        deliberation: { plan: [], brief: '' },
        critique: { refined: false, score: 0 },
        reflection: { insights: [], lessons: [] },
        recalledCount: 0, memorySaved: false,
        prediction: null,
        warnings: ['Unexpected internal error.'],
        correlationId,
      };
    } finally {
      this.processingCount = Math.max(0, this.processingCount - 1);
    }
  }

  /* ---------------- insight → goal ---------------- */
  _feedInsightsToGoals(reflectionResult) {
    if (!reflectionResult || !Array.isArray(reflectionResult.insights) || !reflectionResult.insights.length) return;
    if (!goals || typeof goals.addGoal !== 'function') return;
    const strong = reflectionResult.insights
      .filter(i => i && typeof i === 'object' && Number(i.confidence) >= 0.75 && typeof i.text === 'string')
      .slice(0, 1);
    for (const insight of strong) {
      try {
        goals.addGoal({
          title: `Insight: ${insight.text.slice(0, 80)}`,
          description: insight.text.slice(0, 400),
          priority: 5,
          tags: ['self-learning', 'reflection'],
          source: 'brain-auto',
        });
      } catch (err) { this.logger.debug('Insight → goal failed', { err: err.message }); }
    }
  }

  /* ---------------- feedback ---------------- */
  feedback(correlationId, rating) {
    const num = Number(rating);
    if (!Number.isFinite(num)) return { ok: false, error: 'Rating must be a number.' };
    const entry = [...this.thoughts].reverse().find(t => t.correlationId === correlationId && t.strategy);
    if (!entry) return { ok: false, error: 'No matching interaction found.' };
    const positive = num >= 4 || num === 1;
    this.learner.record(entry.strategy, { success: positive, latencyMs: 0 });
    this.learner.record(entry.strategy, { success: positive, latencyMs: 0 });
    this._think({ stage: 'feedback', correlationId, rating: num, strategy: entry.strategy, positive });
    this._safeEmit('feedback', { correlationId, rating: num, strategy: entry.strategy });
    this._schedulePersist();
    return { ok: true, strategy: entry.strategy, applied: positive ? 'positive' : 'negative' };
  }

  /* ---------------- prediction (NEW) ---------------- */
  /**
   * Naive prediction: what is the user likely to ask next?
   * Uses co-occurring tokens in recent memories. Returns suggestion or null.
   */
  predict(message, memories, options) {
    try {
      // Look at recent assistant turns (from history) + memory content
      const recentTexts = [
        ...options.history.filter(h => h.role === 'user').slice(-3).map(h => h.content),
        ...memories.map(m => m.content),
      ];
      if (!recentTexts.length) return null;

      const messageTokens = tokenize(message);
      const candidates = new Map();
      for (const t of recentTexts) {
        for (const tok of tokenize(t)) {
          if (messageTokens.has(tok) || tok.length < 4) continue;
          candidates.set(tok, (candidates.get(tok) || 0) + 1);
        }
      }
      const top = [...candidates.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (!top.length) return null;
      return {
        likelyTopics: top.map(([t]) => t),
        suggestion: `User might follow up about: ${top.map(([t]) => t).join(', ')}`,
      };
    } catch { return null; }
  }

  /* ---------------- meta self-analysis (NEW) ---------------- */
  analyzeSelf(window = 50) {
    const recent = this.thoughts.slice(-window);
    const outputs = recent.filter(t => t.stage === 'output');
    const total = outputs.length || 1;

    const successCount = outputs.filter(t => t.success).length;
    const avgLatency = outputs.length
      ? outputs.reduce((a, t) => a + (t.latencyMs || 0), 0) / outputs.length
      : 0;
    const avgConfidence = outputs.filter(t => typeof t.confidence === 'number').length
      ? outputs.filter(t => typeof t.confidence === 'number')
              .reduce((a, t) => a + t.confidence, 0) /
        outputs.filter(t => typeof t.confidence === 'number').length
      : 0;

    const strategyUsage = {};
    for (const o of outputs) strategyUsage[o.strategy] = (strategyUsage[o.strategy] || 0) + 1;

    const insights = this.insightMiner.mine(this.thoughts, this.failureMemory, this.learner);

    const recommendations = [];
    if (avgConfidence && avgConfidence < 0.55) recommendations.push('Increase retrieval breadth or lower threshold to boost confidence.');
    if (avgLatency > 15000) recommendations.push('Latency high — consider caching or reducing deliberation for common queries.');
    if (insights.find(i => i.type === 'recurring_failure')) recommendations.push('Address recurring failures at circuit level (retry + fallback).');
    const weak = Object.entries(this.learner.scores).filter(([, v]) => v.total >= 5 && v.wins / v.total < 0.5);
    if (weak.length) recommendations.push(`Reconsider strategies: ${weak.map(([s]) => s).join(', ')}`);

    return {
      windowSize: recent.length,
      successRate: successCount / total,
      avgLatencyMs: Math.round(avgLatency),
      avgConfidence: +avgConfidence.toFixed(3),
      strategyUsage,
      insights,
      recommendations,
      persona: this.persona.snapshot(),
      learner: this.learner.snapshot(),
      failureMemoryTop: this.failureMemory.topSignatures(5),
    };
  }

  /* ---------------- goals / code / snapshot ---------------- */
  async considerNewGoals() {
    const result = { newGoals: [], staleCount: 0, warnings: [] };
    try {
      const summary = (reflection && typeof reflection.summary === 'function') ? (reflection.summary(50) || {}) : {};
      const stale = (goals && typeof goals.stale === 'function') ? goals.stale() : [];
      result.staleCount = Array.isArray(stale) ? stale.length : 0;

      if (Number.isFinite(summary.successRate) && summary.successRate < 0.7 &&
          Number(summary.count) > 10 && goals && typeof goals.addGoal === 'function') {
        const added = goals.addGoal({
          title: 'Improve task success rate',
          description: `Current: ${(summary.successRate * 100).toFixed(1)}%`,
          priority: 8, tags: ['meta', 'performance'], source: 'self-reflection',
        });
        if (added?.ok) result.newGoals.push(added.goal);
      }
    } catch (err) { result.warnings.push(err.message); }
    return result;
  }

  async reviewOwnCode(files = []) {
    if (!Array.isArray(files) || files.length === 0) return { ok: false, error: 'No files provided.' };
    if (!codeAdvisor || typeof codeAdvisor.selfScan !== 'function') return { ok: false, error: 'Code advisor unavailable.' };
    try { return await codeAdvisor.selfScan(files); }
    catch (err) { return { ok: false, error: 'Code review failed.', details: err.message }; }
  }

  snapshot() {
    const safeCall = (fn, fb) => { try { return typeof fn === 'function' ? fn() : fb; } catch { return fb; } };
    return {
      version: CONFIG.version,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      processingCount: this.processingCount,
      stats: { ...this.stats },
      thoughts: this.thoughts.slice(-10),
      knowledge: safeCall(() => knowledge.stats(), { nodes: 0, edges: 0, available: false }),
      goals: safeCall(() => goals.stats(), { active: 0, available: false }),
      strategies: safeCall(() => strategies.stats(), { total: 0, available: false }),
      reflections: safeCall(() => reflection.summary(50), { count: 0, successRate: 0 }),
      codeSuggestions: safeCall(() => codeAdvisor.stats(), { available: false }),
      learning: {
        strategies: this.learner.snapshot(),
        recentFailures: this.failureMemory.snapshot().slice(-5),
      },
      persona: this.persona.snapshot(),
      circuits: Object.values(this.breakers).map(b => b.snapshot()),
    };
  }

  healthCheck() {
    return {
      ok: true,
      version: CONFIG.version,
      processing: this.processingCount,
      circuits: Object.values(this.breakers).map(b => b.snapshot()),
      persistEnabled: !!CONFIG.persistPath,
      learnerStrategies: Object.keys(this.learner.scores).length,
      persona: this.persona.snapshot(),
    };
  }

  async explainSelf() {
    const snap = this.snapshot();
    const meta = this.analyzeSelf(50);
    const learned = Object.entries(this.learner.scores)
      .map(([s, v]) => `${s}: ${v.wins}/${v.total} (${((v.wins / Math.max(v.total, 1)) * 100).toFixed(0)}%)`)
      .join(', ') || 'no data yet';

    const prompt = [
      'Summarize NEXUS Brain status in 4-6 lines of Hinglish.',
      'Mention learning, confidence, and any weak areas you self-observed.',
      `Version: ${snap.version}, uptime: ${snap.uptimeSec}s`,
      `Requests: ${snap.stats.requests}, Success: ${snap.stats.succeeded}, Failed: ${snap.stats.failed}`,
      `Avg confidence (recent): ${(meta.avgConfidence * 100).toFixed(0)}%`,
      `Avg latency: ${meta.avgLatencyMs}ms`,
      `Learned strategies: ${learned}`,
      `Self-insights: ${meta.insights.map(i => i.detail).join(' | ') || 'none'}`,
    ].join('\n');

    try {
      return await this._withTimeout(() => llm.ask(prompt, { temperature: 0.3, maxTokens: 350 }), CONFIG.llmTimeoutMs, 'Self-status summary');
    } catch {
      return `NEXUS Brain v${snap.version} — Requests: ${snap.stats.requests}, Success: ${snap.stats.succeeded}, Confidence: ${(meta.avgConfidence * 100).toFixed(0)}%, Persona: ${JSON.stringify(this.persona.snapshot())}.`;
    }
  }

  shutdown() {
    clearInterval(this._tuneTimer);
    if (this._evolveTimer) clearInterval(this._evolveTimer);
    if (this._consolidateTimer) clearInterval(this._consolidateTimer);
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistNow();
    this.logger.info('BrainCore shut down cleanly');
  }
}

module.exports = new BrainCore();
module.exports.BrainCore = BrainCore;
module.exports.CONFIG = CONFIG;
