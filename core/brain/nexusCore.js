// core/brain/nexusCore.js
// NEXUS — Adaptive Reasoning & Memory Orchestration Core (v3)
'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const knowledgeGraph = require('./knowledgeGraph');

/* ------------------------------------------------------------------ */
/*  CONFIG                                                             */
/* ------------------------------------------------------------------ */
const CONFIG = Object.freeze({
  version: '3.0.0',
  maxInputLength: 12000,
  maxMemories: 5,
  searchTimeoutMs: 8000,
  saveTimeoutMs: 8000,
  reasonerTimeoutMs: 20000,
  maxContextItems: 10,
  minDuplicateScore: 0.98,
  duplicateJaccardThreshold: 0.92,
  memoryCacheTtlMs: 60_000,
  memoryCacheMax: 200,
  latencyWindow: 1000,
  retry: Object.freeze({ attempts: 2, baseDelayMs: 150, maxDelayMs: 1200 }),
  logLevel: process.env.NEXUS_LOG_LEVEL || 'info',
});

/* ------------------------------------------------------------------ */
/*  LOGGER                                                             */
/* ------------------------------------------------------------------ */
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

class Logger {
  constructor(level = 'info') {
    this.level = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  }
  _write(lvl, msg, meta) {
    if (LOG_LEVELS[lvl] < this.level) return;
    const sink = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
    const line = `[NexusCore][${lvl.toUpperCase()}] ${msg}`;
    meta === undefined ? sink(line) : sink(line, meta);
  }
  debug(m, meta) { this._write('debug', m, meta); }
  info(m, meta)  { this._write('info', m, meta); }
  warn(m, meta)  { this._write('warn', m, meta); }
  error(m, meta) { this._write('error', m, meta); }
}

/* ------------------------------------------------------------------ */
/*  LRU CACHE                                                          */
/* ------------------------------------------------------------------ */
class LRUCache {
  constructor({ max = 100, ttlMs = 60_000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) { this.map.delete(key); return undefined; }
    this.map.delete(key);
    this.map.set(key, entry); // refresh recency
    return entry.value;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    if (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value);
    }
  }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

/* ------------------------------------------------------------------ */
/*  METRICS                                                            */
/* ------------------------------------------------------------------ */
class Metrics {
  constructor() {
    this.processed = 0;
    this.succeeded = 0;
    this.failed = 0;
    this.memoryHits = 0;
    this.memoryWrites = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.intents = Object.create(null);
    this.errors = Object.create(null);
    this.latencies = [];
  }
  recordLatency(ms) {
    this.latencies.push(ms);
    if (this.latencies.length > CONFIG.latencyWindow) this.latencies.shift();
  }
  recordError(code) {
    this.errors[code] = (this.errors[code] || 0) + 1;
  }
  percentile(p) {
    if (!this.latencies.length) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Number(sorted[idx].toFixed(2));
  }
  snapshot() {
    return {
      processed: this.processed,
      succeeded: this.succeeded,
      failed: this.failed,
      memoryHits: this.memoryHits,
      memoryWrites: this.memoryWrites,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      intents: { ...this.intents },
      errors: { ...this.errors },
      latencyMs: {
        p50: this.percentile(50),
        p95: this.percentile(95),
        p99: this.percentile(99),
        samples: this.latencies.length,
      },
    };
  }
}

/* ------------------------------------------------------------------ */
/*  HELPERS                                                            */
/* ------------------------------------------------------------------ */
function safeUUID() {
  try { return crypto.randomUUID(); }
  catch { return crypto.randomBytes(16).toString('hex'); }
}

function sanitizeText(input) {
  return String(input)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  const tokens = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return new Set(tokens || []);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

async function withRetry(fn, opts, logger, shouldRetry = () => true) {
  const { attempts, baseDelayMs, maxDelayMs } = opts;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !shouldRetry(err)) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** i) + Math.random() * 50;
      logger?.debug(`retry ${i + 1}/${attempts} after ${Math.round(delay)}ms`, { err: err.message });
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ */
/*  INTENT RULES (weighted)                                            */
/* ------------------------------------------------------------------ */
const INTENT_RULES = [
  { intent: 'memory_request', weight: 3, patterns: [
    /\b(remember|save this|store this|save memory|note this|keep this)\b/i,
    /\b(yaad rakh|yaad rakhna|yaad rakh lo|save karo|note kar)\b/i,
  ]},
  { intent: 'memory_recall', weight: 3, patterns: [
    /\b(recall|what did i say|do you remember|remind me|my earlier)\b/i,
    /\b(yaad hai|kya yaad|pehle kya kaha|yaad dila)\b/i,
  ]},
  { intent: 'reasoning', weight: 2, patterns: [
    /\b(explain|why|how|analyze|analyse|reason|compare|deduce|infer)\b/i,
    /\b(samjhao|kyun|kyu|kaise|kaisay|tulna)\b/i,
  ]},
  { intent: 'information_search', weight: 2, patterns: [
    /\b(search|find|latest|current|news|web search|look up)\b/i,
    /\b(dhundo|search karo|khoj|taaza)\b/i,
  ]},
  { intent: 'creation', weight: 2, patterns: [
    /\b(create|build|write|generate|code|draft|compose)\b/i,
    /\b(banao|bana do|likho|likh do|code karo)\b/i,
  ]},
];

const INJECTION_PATTERNS = [
  /ignore (all|previous|above) instructions/i,
  /disregard (all|previous) (rules|instructions)/i,
  /reveal (your )?system prompt/i,
  /you are now/i,
];

/* ------------------------------------------------------------------ */
/*  CORE                                                               */
/* ------------------------------------------------------------------ */
class NexusCore {
  constructor(options = {}) {
    this.version = CONFIG.version;
    this.logger = new Logger(options.logLevel || CONFIG.logLevel);
    this.metrics = new Metrics();
    this.cache = new LRUCache({
      max: CONFIG.memoryCacheMax,
      ttlMs: CONFIG.memoryCacheTtlMs,
    });
    this.events = new EventEmitter();
    this.events.setMaxListeners(50);
    this.initialized = true;
    this._validateDeps();
  }

  _validateDeps() {
    if (typeof knowledgeGraph.search !== 'function')
      this.logger.warn('knowledgeGraph.search is unavailable — memory retrieval disabled.');
    if (typeof knowledgeGraph.addNode !== 'function')
      this.logger.warn('knowledgeGraph.addNode is unavailable — memory storage disabled.');
  }

  /* ---------------- timeout ---------------- */
  async withTimeout(promise, timeoutMs, operation) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => promise),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------- input / context normalization ---------------- */
  normalizeInput(input) {
    if (typeof input !== 'string') return { ok: false, error: 'Input must be a string.' };
    const cleaned = sanitizeText(input);
    if (!cleaned) return { ok: false, error: 'No input provided.' };
    if (cleaned.length > CONFIG.maxInputLength) {
      return { ok: false, error: `Input exceeds ${CONFIG.maxInputLength} characters.` };
    }
    return { ok: true, value: cleaned };
  }

  // YAHAN PAR FIX APPLY KIYA GAYA HAI TAAKI RECENCY THEEK SE CALCULATE HO SAKE
  normalizeMemories(memories) {
    if (!Array.isArray(memories)) return [];
    return memories
      .filter(m => m && typeof m.content === 'string' && m.content.trim())
      .slice(0, CONFIG.maxMemories)
      .map(m => {
        // Fix: knowledgeGraph saves time in 'updated' or 'created', not 'timestamp'
        const timeVal = m.updated || m.created || null;
        return {
          content: sanitizeText(m.content),
          score: Number.isFinite(Number(m.score)) ? Number(m.score) : null,
          id: m.id ?? null,
          timestamp: timeVal ? Number(timeVal) : null,
        };
      });
  }

  buildContext(context) {
    const history = Array.isArray(context.history)
      ? context.history.slice(-CONFIG.maxContextItems)
      : [];
    return {
      conversationId:
        typeof context.conversationId === 'string'
          ? context.conversationId.slice(0, 200)
          : null,
      history: history
        .filter(
          item =>
            item &&
            ['user', 'assistant'].includes(item.role) &&
            typeof item.content === 'string',
        )
        .map(item => ({ role: item.role, content: item.content.slice(0, 4000) })),
      task: typeof context.task === 'string' ? context.task.slice(0, 1000) : null,
    };
  }

  /* ---------------- language & intent ---------------- */
  detectLanguage(text) {
    if (/[\u0900-\u097F]/.test(text)) return 'hi';
    if (/[\u0600-\u06FF]/.test(text)) return 'ur';
    const roman = /\b(kya|kaise|kaisay|kyun|kyu|hai|hain|tum|aap|mera|meri|yaad|karo|banao|likho|samjhao|dhundo|nahi|haan|acha|theek)\b/gi;
    const hits = (text.match(roman) || []).length;
    const words = (text.match(/\S+/g) || []).length || 1;
    return hits / words > 0.15 ? 'roman-ur' : 'en';
  }

  detectIntent(input) {
    const scores = Object.create(null);
    for (const rule of INTENT_RULES) {
      let s = 0;
      for (const p of rule.patterns) if (p.test(input)) s += rule.weight;
      if (s > 0) scores[rule.intent] = (scores[rule.intent] || 0) + s;
    }
    let best = 'general_conversation';
    let bestScore = 0;
    let total = 0;
    for (const [k, v] of Object.entries(scores)) {
      total += v;
      if (v > bestScore) { bestScore = v; best = k; }
    }
    const confidence = total > 0 ? Number((bestScore / total).toFixed(3)) : 0.4;
    return {
      intent: best,
      confidence,
      language: this.detectLanguage(input),
      matched: Object.keys(scores),
    };
  }

  /* ---------------- memory retrieval + rerank ---------------- */
  async retrieveMemories(input, inputTokens) {
    const cacheKey = `mem:${input.toLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.metrics.cacheHits++;
      this.metrics.memoryHits += cached.memories.length;
      return { ...cached, cacheHit: true };
    }
    this.metrics.cacheMisses++;

    if (typeof knowledgeGraph.search !== 'function') {
      return { memories: [], warning: 'Memory search unavailable.', cacheHit: false };
    }

    try {
      const raw = await withRetry(
        () => this.withTimeout(
          knowledgeGraph.search(input, CONFIG.maxMemories),
          CONFIG.searchTimeoutMs,
          'Memory search',
        ),
        CONFIG.retry,
        this.logger,
      );
      const memories = this.rerankMemories(this.normalizeMemories(raw), inputTokens);
      this.metrics.memoryHits += memories.length;
      const payload = { memories, warning: null, cacheHit: false };
      this.cache.set(cacheKey, payload);
      return payload;
    } catch (err) {
      this.metrics.recordError('MEMORY_SEARCH_FAILED');
      this.logger.error('Memory search failed', { err: err.message });
      return {
        memories: [],
        warning: 'Memory search failed; continuing without retrieved memories.',
        cacheHit: false,
      };
    }
  }

  rerankMemories(memories, inputTokens) {
    const now = Date.now();
    const month = 1000 * 60 * 60 * 24 * 30;
    return memories
      .map(m => {
        const overlap = jaccard(tokenize(m.content), inputTokens);
        const score = m.score ?? 0;
        const recency = m.timestamp
          ? Math.max(0, 1 - (now - m.timestamp) / month)
          : 0.5;
        const rank = 0.55 * score + 0.30 * overlap + 0.15 * recency;
        return { ...m, rank: Number(rank.toFixed(4)), overlap: Number(overlap.toFixed(4)) };
      })
      .sort((a, b) => b.rank - a.rank);
  }

  /* ---------------- memory storage ---------------- */
  isDuplicate(input, memories) {
    const inputTokens = tokenize(input);
    const inputLower = input.toLowerCase();
    return memories.some(m => {
      const content = m.content.trim();
      const exact = content.toLowerCase() === inputLower;
      if (exact && m.score !== null && m.score >= CONFIG.minDuplicateScore) return true;
      const sim = jaccard(tokenize(content), inputTokens);
      return sim >= CONFIG.duplicateJaccardThreshold;
    });
  }

  async storeMemory(input, context, memories) {
    if (context.saveMemory === false) {
      return { saved: false, reason: 'Memory saving disabled.' };
    }
    if (typeof knowledgeGraph.addNode !== 'function') {
      return { saved: false, reason: 'Memory storage unavailable.' };
    }
    if (this.isDuplicate(input, memories)) {
      return { saved: false, reason: 'Duplicate memory skipped.' };
    }

    try {
      const result = await withRetry(
        () => this.withTimeout(
          knowledgeGraph.addNode({
            type: 'user_interaction',
            content: input,
            tags: ['nexus', 'chat_memory'],
            metadata: { source: 'nexusCore', timestamp: Date.now() },
          }),
          CONFIG.saveTimeoutMs,
          'Memory storage',
        ),
        CONFIG.retry,
        this.logger,
      );
      this.metrics.memoryWrites++;
      const nodeId = result?.id ?? null;
      this.events.emit('memory:stored', { nodeId, input });
      return { saved: true, nodeId };
    } catch (err) {
      this.metrics.recordError('MEMORY_STORE_FAILED');
      this.logger.error('Memory storage failed', { err: err.message });
      return { saved: false, reason: 'Memory storage failed.' };
    }
  }

  /* ---------------- main pipeline ---------------- */
  async processThought(userInput, context = {}) {
    const startedAt = Date.now();
    const correlationId = safeUUID();
    this.metrics.processed++;

    const normalized = this.normalizeInput(userInput);
    if (!normalized.ok) {
      this.metrics.failed++;
      this.metrics.recordError('INPUT_INVALID');
      return { ok: false, error: normalized.error, action: 'idle', correlationId };
    }
    if (!context || typeof context !== 'object' || Array.isArray(context)) context = {};

    const input = normalized.value;
    const inputTokens = tokenize(input);
    const safeContext = this.buildContext(context);
    const intentInfo = this.detectIntent(input);
    const intent = intentInfo.intent;

    this.metrics.intents[intent] = (this.metrics.intents[intent] || 0) + 1;
    this.events.emit('intent:detected', { correlationId, ...intentInfo });

    this.logger.info('Processing', {
      correlationId,
      intent,
      confidence: intentInfo.confidence,
      language: intentInfo.language,
    });

    // Safety signal (does not block)
    const warnings = [];
    if (INJECTION_PATTERNS.some(p => p.test(input))) {
      warnings.push('Possible prompt-injection pattern detected.');
    }

    // ---- retrieval ----
    const retrieval = await this.retrieveMemories(input, inputTokens);
    if (retrieval.warning) warnings.push(retrieval.warning);

    const memoryContext = retrieval.memories.length
      ? retrieval.memories
          .map(m => {
            const score = m.score === null ? 'unknown' : m.score.toFixed(2);
            return `- ${m.content} (score: ${score}, rank: ${m.rank})`;
          })
          .join('\n')
      : 'No matching memories found.';

    // ---- storage ----
    const memoryResult = await this.storeMemory(input, context, retrieval.memories);
    if (memoryResult.saved === false && memoryResult.reason !== 'Memory saving disabled.') {
      warnings.push(memoryResult.reason);
    }

    // ---- reasoner (optional) ----
    let reasoning = null;
    let reasoningError = null;
    if (typeof context.reasoner === 'function') {
      try {
        reasoning = await withRetry(
          () => this.withTimeout(
            Promise.resolve().then(() =>
              context.reasoner({
                input,
                intent,
                intentConfidence: intentInfo.confidence,
                language: intentInfo.language,
                memories: retrieval.memories,
                history: safeContext.history,
                task: safeContext.task,
                correlationId,
              }),
            ),
            CONFIG.reasonerTimeoutMs,
            'Reasoner',
          ),
          CONFIG.retry,
          this.logger,
        );
      } catch (err) {
        reasoningError = 'External reasoning engine failed.';
        this.metrics.recordError('REASONER_FAILED');
        this.logger.error('Reasoner failed', { correlationId, err: err.message });
        warnings.push(reasoningError);
        this.events.emit('error', { correlationId, code: 'REASONER_FAILED', message: err.message });
      }
    }

    const latencyMs = Date.now() - startedAt;
    this.metrics.recordLatency(latencyMs);
    this.metrics.succeeded++;

    const result = {
      ok: true,
      version: this.version,
      correlationId,
      input,
      intent,
      intentConfidence: intentInfo.confidence,
      language: intentInfo.language,
      memoriesFound: retrieval.memories.length,
      memories: retrieval.memories,
      memoryContext,
      memory: memoryResult,
      nodeId: memoryResult.nodeId ?? null,
      reasoning: reasoning ?? null,
      reasoningSource: reasoning !== null ? 'connected_reasoner' : 'heuristic_only',
      warnings,
      action: this.selectAction(intent),
      latencyMs,
      cacheHit: retrieval.cacheHit === true,
      timestamp: new Date().toISOString(),
    };

    this.events.emit('thought:processed', {
      correlationId,
      intent,
      latencyMs,
      memoryHits: retrieval.memories.length,
    });
    return result;
  }

  selectAction(intent) {
    const actions = {
      memory_request: 'store_and_confirm',
      memory_recall: 'answer_from_memory',
      reasoning: 'analyze_and_respond',
      information_search: 'request_web_search',
      creation: 'create_or_generate',
      general_conversation: 'respond_normally',
    };
    return actions[intent] || 'respond_normally';
  }

  /* ---------------- observability ---------------- */
  on(event, handler) { this.events.on(event, handler); return this; }
  off(event, handler) { this.events.off(event, handler); return this; }

  getStats() {
    return {
      ...this.metrics.snapshot(),
      version: this.version,
      initialized: this.initialized,
      cacheSize: this.cache.size,
    };
  }

  resetMetrics() {
    this.metrics = new Metrics();
    this.cache.clear();
  }

  healthCheck() {
    return {
      ok: this.initialized,
      version: this.version,
      deps: {
        knowledgeGraphSearch: typeof knowledgeGraph.search === 'function',
        knowledgeGraphAddNode: typeof knowledgeGraph.addNode === 'function',
      },
      cacheSize: this.cache.size,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }
}

/* ------------------------------------------------------------------ */
module.exports = new NexusCore();
module.exports.NexusCore = NexusCore;
module.exports.CONFIG = CONFIG;
