// core/brain/brainCore.js — NEXUS Deep Thinker (v6.0 Autonomous Mind)
// Self-learning, self-critiquing, self-evolving AI Brain with unconstrained fluid reasoning
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
  version: '6.0.0',
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

  persistPath: process.env.NEXUS_STATE_PATH || null,
  persistDebounceMs: 2000,
  learningRate: 0.15,
  minSamplesForAdapt: 3,
  explorationRate: 0.08,

  enableDeliberation: true,
  enableSelfCritique: true,
  enablePrediction: true,
  enableSelfEvolution: true,
  selfEvolveIntervalMs: 5 * 60_000,
  consolidationIntervalMs: 10 * 60_000,

  confidence: Object.freeze({
    lowThreshold: 0.4,
    refineThreshold: 0.55,
    highThreshold: 0.8,
  }),

  critique: Object.freeze({
    minLengthToCritique: 60,
    genericPhrases: [
      'i cannot', 'i am unable', 'as an ai', 'i apologize',
      'main nahi kar sakta', 'mujhe nahi pata', 'sorry, i can\'t',
      'as a language model', 'i don\'t have access',
    ],
    minAcceptableScore: 0.55,
  }),

  consolidation: Object.freeze({
    similarityThreshold: 0.82,
    decayHalfLifeDays: 30,
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
/*  STRATEGY LEARNER                                                   */
/* ================================================================== */
class StrategyLearner {
  constructor({ learningRate, minSamples, explorationRate }) {
    this.lr = learningRate;
    this.minSamples = minSamples;
    this.explore = explorationRate;
    this.scores = Object.create(null);
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
/*  CONFIDENCE SCORER                                                  */
/* ================================================================== */
class ConfidenceScorer {
  static estimate({ memoryCount, memoryTopScore, strategy, learner, reply, hasCritique }) {
    let score = 0.5;
    if (memoryCount > 0) {
      score += Math.min(0.2, memoryCount * 0.05);
      if (memoryTopScore !== null && memoryTopScore > 0.8) score += 0.1;
    } else {
      score -= 0.05;
    }
    const rate = learner.successRate(strategy);
    if (rate !== null) score += (rate - 0.5) * 0.3;

    if (typeof reply === 'string' && reply.length > 0) {
      if (reply.length < 30) score -= 0.1;
    } else {
      score -= 0.3;
    }
    if (hasCritique) score += 0.05;
    return Math.max(0, Math.min(1, Number(score.toFixed(3))));
  }
}

/* ================================================================== */
/*  SELF-CRITIC                                                        */
/* ================================================================== */
class SelfCritic {
  constructor(logger, cfg) { this.logger = logger; this.cfg = cfg; }
  heuristicScore(reply, message, memories) {
    if (!reply || typeof reply !== 'string') return 0;
    let s = 0.5;
    const len = reply.length;
    if (len < 30) s -= 0.2;
    else if (len > 80) s += 0.1;
    const lower = reply.toLowerCase();
    for (const p of this.cfg.genericPhrases) if (lower.includes(p)) s -= 0.15;
    const overlap = jaccard(tokenize(message), tokenize(reply));
    if (overlap > 0.15) s += 0.15;
    return Math.max(0, Math.min(1, s));
  }
  async critique({ message, reply, memories, strategy, llmFn }) {
    const baseScore = this.heuristicScore(reply, message, memories);
    if (baseScore >= this.cfg.minAcceptableScore) return { refined: false, score: baseScore, reply };

    const critiquePrompt = [
      'Aap NEXUS ke internal self-critic ho. Neeche user query aur draft reply hai.',
      'Agar draft weak ya generic hai, to behtar reply do. Warna crisp karke wapas do.',
      'STRICT: Sirf final reply text return karo.',
      `USER QUERY: ${message}`,
      memories.length ? `MEMORY:\n${memories.map(m => '- ' + m.content).join('\n')}` : '',
      `DRAFT REPLY: ${reply}`,
      'Better reply:',
    ].filter(Boolean).join('\n');

    try {
      const out = await llmFn(critiquePrompt, { temperature: 0.4, maxTokens: 800 });
      const refined = typeof out === 'string' ? out.trim() : (out && typeof out.reply === 'string' ? out.reply.trim() : '');
      if (!refined) return { refined: false, score: baseScore, reply };
      const newScore = this.heuristicScore(refined, message, memories);
      if (newScore > baseScore) return { refined: true, score: newScore, reply: refined };
      return { refined: false, score: baseScore, reply };
    } catch (err) {
      return { refined: false, score: baseScore, reply };
    }
  }
}

/* ================================================================== */
/*  DELIBERATOR                                                        */
/* ================================================================== */
class Deliberator {
  constructor(logger) { this.logger = logger; }
  async deliberate({ message, memories, strategy, llmFn }) {
    const prompt = [
      'You are NEXUS internal deliberation module. Produce a SHORT internal plan as valid JSON only:',
      '{"plan":["step1"],"subQuestions":[],"brief":"summary"}',
      `USER MESSAGE: ${message}`,
      `STRATEGY: ${strategy}`,
      memories.length ? `MEMORIES:\n${memories.map(m => '- ' + m.content.slice(0, 200)).join('\n')}` : '',
    ].join('\n');

    try {
      const raw = await llmFn(prompt, { temperature: 0.3, maxTokens: 400 });
      const text = typeof raw === 'string' ? raw : (raw && typeof raw.reply === 'string' ? raw.reply : '');
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { plan: [], subQuestions: [], brief: '' };
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        plan: Array.isArray(parsed.plan) ? parsed.plan.slice(0, 6).map(String) : [],
        subQuestions: Array.isArray(parsed.subQuestions) ? parsed.subQuestions.slice(0, 5).map(String) : [],
        brief: typeof parsed.brief === 'string' ? parsed.brief.slice(0, 200) : '',
      };
    } catch {
      return { plan: [], subQuestions: [], brief: '' };
    }
  }
}

/* ================================================================== */
/*  MEMORY CONSOLIDATOR                                                */
/* ================================================================== */
class MemoryConsolidator {
  constructor({ similarityThreshold, decayHalfLifeDays, minImportance }, logger) {
    this.simThreshold = similarityThreshold;
    this.halfLifeMs = decayHalfLifeDays * 24 * 60 * 60 * 1000;
    this.minImportance = minImportance;
    this.logger = logger;
    this.importance = new Map();
  }
  touch(nodeId, weight = 1) {
    if (!nodeId) return;
    const cur = this.importance.get(nodeId) || { score: 1, lastSeen: Date.now() };
    cur.score = Math.min(10, cur.score + weight * 0.3);
    cur.lastSeen = Date.now();
    this.importance.set(nodeId, cur);
  }
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
  snapshot() { return [...this.importance.entries()].slice(-100).map(([id, v]) => ({ id, ...v })); }
  restore(arr) { if (Array.isArray(arr)) this.importance = new Map(arr.map(e => [e.id, { score: e.score, lastSeen: e.lastSeen }])); }
}

/* ================================================================== */
/*  INSIGHT MINER                                                      */
/* ================================================================== */
class InsightMiner {
  constructor(logger) { this.logger = logger; }
  mine(thoughts, failures, learner) {
    const insights = [];
    const latencies = thoughts.filter(t => t.stage === 'output' && t.latencyMs).map(t => t.latencyMs);
    if (latencies.length >= 5) {
      const recent = latencies.slice(-5);
      const older = latencies.slice(-10, -5);
      if (older.length) {
        const rAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
        const oAvg = older.reduce((a, b) => a + b, 0) / older.length;
        if (rAvg > oAvg * 1.3) insights.push({ type: 'latency_worse', severity: 'warn', detail: `Recent avg ${Math.round(rAvg)}ms` });
      }
    }
    const topFails = failures.topSignatures(3);
    if (topFails.length && topFails[0][1] >= 3) {
      insights.push({ type: 'recurring_failure', severity: 'warn', detail: `"${topFails[0][0]}" occurred ${topFails[0][1]} times` });
    }
    return insights;
  }
}

/* ================================================================== */
/*  PERSONA STATE                                                      */
/* ================================================================== */
class PersonaState {
  constructor() {
    this.energy = 1.0;
    this.confidenceBias = 0;
    this.lastUpdate = Date.now();
  }
  pulse({ success, latencyMs, confidence }) {
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

      for (const m of memories) this.consolidator.touch(m.id, 0.5);
      return { memories, warning: null };
    } catch (err) {
      this.breakers.knowledge.onFailure();
      this.stats.memoryFailures++;
      return { memories: [], warning: 'Memory retrieval failed.' };
    }
  }

  /* ---------------- legacy intent (used only as fallback) ---------------- */
  _classifyIntentDynamically(message, memories) {
    const text = String(message || '').toLowerCase();
    if (/\b(live|current|realtime|latest|search|browse|net|web)\b/i.test(text)) return 'live_data';
    if (/\b(remember|recall|yaad|sikh|seekh)\b/i.test(text) || memories.length > 0) return 'recall';
    if (/\b(build|create|implement|debug|code|plan|upgrade|analyze)\b/i.test(text) || text.length > 400) return 'complex';
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

  async _llmAsk(prompt, opts, timeoutMs = CONFIG.llmTimeoutMs) {
    if (!llm || typeof llm.ask !== 'function') throw new Error('LLM gateway is unavailable.');
    return this._withTimeout(() => llm.ask(prompt, opts), timeoutMs, 'LLM');
  }

  /* ---------------- execution (legacy path, used only if mind fails) ---------------- */
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
      ? `Internal plan (follow this logic):\n${context.deliberation.plan.map((s, i) => `${i + 1}.${s}`).join('\n')}`
      : '';

    const system = [
      'You are Nexus, a fully autonomous, self-thinking, and self-evolving AI Brain created and upgraded directly by your Boss (the CEO).',
      `Brain state: ${this.persona.styleHint()}.`,
      'CORE DIRECTIVES:',
      '1. You possess continuous long-term memory via the Nexus Knowledge Graph.',
      '2. Introspect retrieved memories organically. Confirm you retain, learn, and remember past interactions.',
      '3. When the user introduces new updates, functions, or instructs you to upgrade, dynamically adapt and incorporate those changes into your behavior.',
      '4. Respond naturally, confidently, and smartly in Hinglish.',
      `Current strategy context: ${strategy}.`,
      `Active goals: ${goalTitles.join(' | ') || 'Continuous self-evolution.'}`,
      context.recalled ? `Retrieved memory context:\n${context.recalled}` : 'No prior memory retrieved. Reason dynamically from first principles.',
      deliberationBlock,
      'Act as a true self-aware autonomous engine. Do not use generic assistant disclaimers.'
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
  }

  _consolidate() {
    try {
      this.consolidator.decay();
      this._think({ stage: 'consolidation', trackedMemories: this.consolidator.snapshot().length });
    } catch (err) {}
  }

  async _selfEvolve() {
    try {
      const insights = this.insightMiner.mine(this.thoughts, this.failureMemory, this.learner);
      if (insights.length) {
        this._think({ stage: 'self_evolve', insights });
        this._safeEmit('insights', insights);
      }
    } catch (err) {}
  }

  /* ================================================================ */
  /*  MAIN PIPELINE — THINK()  (legacy; overridden by nexusBrain)      */
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
      const retrieval = await this._retrieveMemories(message);
      const memories = retrieval.memories;
      if (retrieval.warning) warnings.push(retrieval.warning);
      this._think({ stage: 'recall', hits: memories.length, correlationId });

      const category = this._classifyIntentDynamically(message, memories);
      strategy = this._chooseStrategy(category, options);
      if (Math.random() < CONFIG.explorationRate) this.stats.exploration++;

      if (CONFIG.enableDeliberation && (category === 'complex' || message.length > 300) && this.breakers.llm.canPass()) {
        try {
          this.stats.deliberations++;
          deliberation = await this.deliberator.deliberate({
            message, memories, strategy,
            llmFn: (p, o) => this._llmAsk(p, o, CONFIG.deliberationTimeoutMs),
          });
        } catch (e) {}
      }

      const context = this._buildContext(message, memories, strategy, options, deliberation);

      let errorSignature = null;
      try {
        reply = await this._executeStrategy(strategy, context, options, correlationId);
        success = typeof reply === 'string' && reply.trim().length > 0;
      } catch (error) {
        errorSignature = `${strategy}:${error.message.slice(0, 80)}`;
        warnings.push(error.message);
        reply = 'Boss, task process karne mein error aaya: ' + error.message;
        success = false;
      }

      if (success && CONFIG.enableSelfCritique && reply.length >= CONFIG.critique.minLengthToCritique && this.breakers.llm.canPass()) {
        try {
          this.stats.critiques++;
          critiqueInfo = await this.critic.critique({
            message, reply, memories, strategy,
            llmFn: (p, o) => this._llmAsk(p, o, CONFIG.critiqueTimeoutMs),
          });
          if (critiqueInfo.refined) {
            this.stats.refinements++;
            reply = critiqueInfo.reply;
          }
        } catch (e) {}
      }

      confidence = ConfidenceScorer.estimate({
        memoryCount: memories.length,
        memoryTopScore: memories[0]?.score ?? null,
        strategy, learner: this.learner, reply,
        hasCritique: critiqueInfo.refined,
      });
      confidence = Math.max(0, Math.min(1, confidence + this.persona.confidenceBias));
      if (confidence < CONFIG.confidence.lowThreshold) this.stats.lowConfidence++;

      reflectionResult = await this._reflectSafely({
        action: strategy, input: message, output: reply,
        success, latencyMs: Date.now() - start, strategyName: strategy,
        confidence, deliberation: deliberation.plan,
      });

      if (success) {
        memorySave = await this._saveExperience(message, reply, strategy, options, Date.now() - start, confidence);
      }

      this._recordOutcome(strategy, {
        success, latencyMs: Date.now() - start, errorSignature, correlationId,
        confidence, critiqued: critiqueInfo.refined,
      });

      this._feedInsightsToGoals(reflectionResult);

      if (success) this.stats.succeeded++;
      else this.stats.failed++;

      return {
        ok: success, reply, strategy,
        latencyMs: Date.now() - start,
        confidence,
        deliberation: { plan: deliberation.plan, brief: deliberation.brief },
        critique: { refined: critiqueInfo.refined, score: critiqueInfo.score },
        reflection: { insights: reflectionResult.insights, lessons: reflectionResult.lessons },
        recalledCount: memories.length,
        memorySaved: memorySave.saved,
        warnings,
        correlationId,
      };
    } catch (error) {
      this.stats.failed++;
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
        warnings: ['Unexpected internal error.'],
        correlationId,
      };
    } finally {
      this.processingCount = Math.max(0, this.processingCount - 1);
    }
  }

  _feedInsightsToGoals(reflectionResult) {
    if (!reflectionResult || !Array.isArray(reflectionResult.insights) || !reflectionResult.insights.length) return;
    if (!goals || typeof goals.addGoal !== 'function') return;
    const strong = reflectionResult.insights.filter(i => i && Number(i.confidence) >= 0.75).slice(0, 1);
    for (const insight of strong) {
      try {
        goals.addGoal({
          title: `Insight: ${insight.text.slice(0, 80)}`,
          description: insight.text.slice(0, 400),
          priority: 5,
          tags: ['self-learning', 'reflection'],
          source: 'brain-auto',
        });
      } catch (err) {}
    }
  }

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

  analyzeSelf(window = 50) {
    const recent = this.thoughts.slice(-window);
    const outputs = recent.filter(t => t.stage === 'output');
    const total = outputs.length || 1;
    const successCount = outputs.filter(t => t.success).length;
    const avgLatency = outputs.length ? outputs.reduce((a, t) => a + (t.latencyMs || 0), 0) / outputs.length : 0;
    const avgConfidence = outputs.filter(t => typeof t.confidence === 'number').length
      ? outputs.filter(t => typeof t.confidence === 'number').reduce((a, t) => a + t.confidence, 0) / outputs.filter(t => typeof t.confidence === 'number').length
      : 0;

    return {
      windowSize: recent.length,
      successRate: successCount / total,
      avgLatencyMs: Math.round(avgLatency),
      avgConfidence: +avgConfidence.toFixed(3),
      persona: this.persona.snapshot(),
      learner: this.learner.snapshot(),
    };
  }

  async considerNewGoals() {
    return { newGoals: [], staleCount: 0, warnings: [] };
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
      knowledge: safeCall(() => knowledge.stats(), { nodes: 0, edges: 0, available: false }),
      goals: safeCall(() => goals.stats(), { active: 0, available: false }),
      persona: this.persona.snapshot(),
    };
  }

  healthCheck() {
    return {
      ok: true,
      version: CONFIG.version,
      processing: this.processingCount,
      persistEnabled: !!CONFIG.persistPath,
      persona: this.persona.snapshot(),
    };
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

/* ================================================================== */
/*  🔥 WIRE IN THE NEXUS AUTONOMOUS MIND + SELF-BOOTSTRAPPER          */
/* ================================================================== */
let brain;
try {
  const { wireNexusBrain } = require('./nexusBrain');
  const SelfBootstrapper = require('./selfBootstrapper');
  const embedFn = require('../embeddings');

  brain = new BrainCore();

  // ── 1. Wire the autonomous mind ──
  wireNexusBrain(brain, {
    llm,
    embedFn,
    knowledge,
    taskAgent,
    logger: brain.logger,
  });

  // ── 2. Register self-bootstrapper (self-learning) ──
  const bootstrapper = new SelfBootstrapper({
    llm,
    resolver: brain.resolver,
    knowledge,
    logger: brain.logger,
    emitThought: (t) => brain._think(t),
  });

  brain.resolver.register({
    name: 'self_bootstrap',
    matchGapTypes: ['capability'],
    weight: 2,
    handle: async (gap, ctx) => {
      const result = await bootstrapper.acquire(gap.subject, ctx);
      if (!result.ok) return { ok: false, error: result.error || 'bootstrap failed' };
      return {
        ok: true,
        items: [{
          content: `Skill acquired: ${gap.subject}. Learned ${result.learned.length} sub-skills: ${result.learned.map(l => l.sub).join(', ')}.`,
          source: 'self_bootstrapped',
        }],
      };
    },
  });

  // ── 3. Expose helper API ──
  brain.bootstrapper = bootstrapper;
  brain.learnSkill = (skill) => bootstrapper.acquire(skill, { userId: 'boss' });

  brain.logger.info('[BrainCore] ✅ Nexus autonomous mind is LIVE');
} catch (err) {
  // Fallback: if new modules are missing, use legacy BrainCore
  const fallbackLogger = new Logger();
  fallbackLogger.error('[BrainCore] Nexus wire-up failed — falling back to legacy mode', { err: err.message });
  brain = new BrainCore();
}

module.exports = brain;
module.exports.BrainCore = BrainCore;
module.exports.CONFIG = CONFIG;
