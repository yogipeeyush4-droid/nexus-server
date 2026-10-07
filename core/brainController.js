const EventEmitter = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const taskAgent = require('../agents/taskAgent');
const plannerAgent = require('../agents/plannerAgent');
const evolutionAgent = require('../agents/evolutionAgent');
const skillBuilder = require('../agents/SkillBuilderAgent');
const memoryManager = require('../core/memoryManager');
const webSearchAgent = require('../agents/webSearchAgent');
const bugFixAgent = require('../agents/bugFixAgent');

// ============ CONFIG ============
const CONFIG = {
  maxHistory: 500,
  cacheTtlMs: 60 * 1000,
  enableCache: true,
  enableRetry: true,
  maxRetries: 2,
  retryDelayMs: 400,
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 30000,
  },
  mode: process.env.BRAIN_MODE || 'adaptive',   // fast | full | adaptive | safe
  logLevel: process.env.LOG_LEVEL || 'info',
  parallel: {
    enabled: true,
    maxConcurrency: 4,
  },
  persistFile: process.env.BRAIN_STATE ||
    path.join(process.cwd(), '.brain-state.json'),
};

// ============ LOGGER ============
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CL = LEVELS[CONFIG.logLevel] || 2;
function log(level, msg, meta) {
  if (LEVELS[level] > CL) return;
  const line = meta
    ? `[Brain] ${level.toUpperCase()} ${msg} ${JSON.stringify(meta)}`
    : `[Brain] ${level.toUpperCase()} ${msg}`;
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

// ============ CIRCUIT BREAKER ============
class CircuitBreaker {
  constructor(name, opts = {}) {
    this.name = name;
    this.failures = 0;
    this.threshold = opts.failureThreshold || CONFIG.circuitBreaker.failureThreshold;
    this.resetTimeout = opts.resetTimeoutMs || CONFIG.circuitBreaker.resetTimeoutMs;
    this.state = 'closed';   // closed | open | half-open
    this.openedAt = null;
  }

  canExecute() {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.resetTimeout) {
        this.state = 'half-open';
        return true;
      }
      return false;
    }
    return true; // half-open — allow one shot
  }

  success() {
    this.failures = 0;
    this.state = 'closed';
  }

  fail() {
    this.failures++;
    if (this.state === 'half-open' || this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }

  snapshot() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      openedAt: this.openedAt,
    };
  }
}

const breakers = {
  task: new CircuitBreaker('task'),
  plan: new CircuitBreaker('plan'),
  evolution: new CircuitBreaker('evolution'),
  skill: new CircuitBreaker('skill'),
};

// ============ INTENT CLASSIFIER ============
// Detects what user actually wants — avoids doing full pipeline every time
const INTENT_PATTERNS = {
  analyze: [
    /\b(scan|analyze|analyse|inspect|audit|report)\b/i,
    /\bproject\s+(health|status)\b/i,
  ],
  plan: [
    /\b(plan|roadmap|strategy|prioriti[sz]e)\b/i,
    /\bwhat\s+(should|to)\s+(i|we)\s+do\b/i,
  ],
  evolve: [
    /\b(evolve|evolution|grow|upgrade|improve\s+everything)\b/i,
  ],
  fix: [
    /\b(fix|repair|resolve|patch|debug)\b.*\b(bug|issue|error|problem)\b/i,
    /\bbug\b/i,
  ],
  skill: [
    /\b(skill|capability)\b/i,
  ],
  status: [
    /\b(status|ping|health|alive|hi|hello)\b/i,
  ],
  help: [
    /\b(help|commands|what can you do)\b/i,
  ],
};

function classifyIntent(command) {
  const text = String(command || '').trim();
  const scores = {};

  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    let score = 0;
    for (const p of patterns) if (p.test(text)) score += 5;
    if (score > 0) scores[intent] = score;
  }

  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return top
    ? { intent: top[0], confidence: top[1], allScores: scores }
    : { intent: 'unknown', confidence: 0, allScores: scores };
}

// ============ PIPELINE DEFINITIONS ============
// Each mode = what steps to run
const PIPELINES = {
  fast: {
    description: 'Minimal — just the task result',
    steps: ['task'],
  },
  status: {
    description: 'Quick health/status check',
    steps: ['status'],
  },
  analyze: {
    description: 'Scan + task',
    steps: ['task'],
  },
  plan: {
    description: 'Task + planning',
    steps: ['task', 'plan'],
  },
  full: {
    description: 'Task + plan + evolution',
    steps: ['task', 'plan', 'evolution'],
  },
  adaptive: {
    description: 'Auto-selects based on intent',
    steps: 'dynamic',
  },
  safe: {
    description: 'Full pipeline + no writes',
    steps: ['task', 'plan', 'evolution'],
    options: { dryRun: true },
  },
};

// ============ CACHE ============
const cache = new Map(); // key → { value, expiresAt }

function cacheGet(key) {
  if (!CONFIG.enableCache) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttl = CONFIG.cacheTtlMs) {
  if (!CONFIG.enableCache) return;
  cache.set(key, { value, expiresAt: Date.now() + ttl });
}

function cacheClear() {
  cache.clear();
}

// ============ UTILS ============
function uid(p = 'op') {
  return `${p}_${crypto.randomBytes(5).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function retry(fn, attempts = 2, delay = 400) {
  let lastErr;
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        await new Promise((r) => setTimeout(r, delay * (i + 1)));
      }
    }
  }
  throw lastErr;
}

// ============ STATUS BUILDER ============
function buildStatus() {
  const mem = process.memoryUsage();
  return {
    brain: 'online',
    mode: CONFIG.mode,
    uptimeSec: Math.floor(process.uptime()),
    memoryMB: +(mem.heapUsed / 1024 / 1024).toFixed(2),
    node: process.version,
    pid: process.pid,
    breakers: Object.values(breakers).map((b) => b.snapshot()),
    time: nowIso(),
  };
}

// ============ BRAIN CONTROLLER ============
class BrainController extends EventEmitter {
  constructor() {
    super();
    this.stats = {
      total: 0,
      success: 0,
      failed: 0,
      cached: 0,
      byIntent: {},
      byMode: {},
      avgDurationMs: 0,
      totalDurationMs: 0,
    };
    this.history = [];
    this._persistTimer = null;
  }

  // ---------- MAIN PROCESS ----------
  async process(command, options = {}) {
    const opId = uid('op');
    const t0 = Date.now();

    const ctx = {
      opId,
      command,
      options,
      mode: options.mode || CONFIG.mode,
      startedAt: t0,
      user: options.user || { id: 'anonymous', permissions: ['user', 'admin'] },
      cache: options.cache !== false,
      dryRun: options.dryRun === true,
      steps: {},
      errors: [],
      warnings: [],
    };

    this.stats.total++;

    try {
      // 1) Classify intent
      ctx.intent = classifyIntent(command);

      log('debug', 'intent classified', {
        opId,
        intent: ctx.intent.intent,
        confidence: ctx.intent.confidence,
      });

      // 2) Resolve pipeline
      ctx.pipeline = this._resolvePipeline(ctx);

      // 3) Cache check
      const cacheKey = this._cacheKey(ctx);
      if (ctx.cache && ctx.pipeline.length > 1) {
        const cached = cacheGet(cacheKey);
        if (cached) {
          this.stats.cached++;
          this.emit('brain:cache_hit', { opId, key: cacheKey });
          return {
            ...cached,
            cached: true,
            opId,
            durationMs: Date.now() - t0,
          };
        }
      }

      // 4) Execute pipeline
      const result = await this._runPipeline(ctx);

      // 5) Store in cache (if beneficial)
      if (ctx.cache && ctx.pipeline.length > 1) {
        cacheSet(cacheKey, {
          command,
          intent: ctx.intent,
          mode: ctx.mode,
          timestamp: nowIso(),
          ...result,
        });
      }

      // 6) Finalize
      const durationMs = Date.now() - t0;
      const final = {
        ok: ctx.errors.length === 0,
        opId,
        command,
        intent: ctx.intent,
        mode: ctx.mode,
        pipeline: ctx.pipeline,
        timestamp: nowIso(),
        durationMs,
        errors: ctx.errors,
        warnings: ctx.warnings,
        ...result,
      };

      this._record(ctx, final);
      this.emit('brain:done', { opId, durationMs, ok: final.ok });

      return final;

    } catch (err) {
      ctx.errors.push({ message: err.message });
      this.stats.failed++;

      log('error', 'brain process failed', { opId, err: err.message });

      this.emit('brain:error', { opId, error: err.message });

      return {
        ok: false,
        opId,
        command,
        intent: ctx.intent,
        mode: ctx.mode,
        error: err.message,
        errors: ctx.errors,
        durationMs: Date.now() - t0,
      };
    }
  }

  // ---------- PIPELINE RESOLUTION ----------
  _resolvePipeline(ctx) {
    const modeCfg = PIPELINES[ctx.mode] || PIPELINES.adaptive;

    // Explicit steps from options
    if (Array.isArray(ctx.options.steps)) return ctx.options.steps;

    // Non-adaptive: respect mode config
    if (ctx.mode !== 'adaptive') {
      return modeCfg.steps;
    }

    // Adaptive: choose steps based on intent
    const intent = ctx.intent.intent;

    if (intent === 'status' || intent === 'help') {
      return ['status'];
    }

    if (intent === 'analyze') {
      return ['task'];
    }

    if (intent === 'plan') {
      return ['task', 'plan'];
    }

    if (intent === 'evolve') {
      return ['task', 'plan', 'evolution'];
    }

    if (intent === 'fix') {
      return ['task', 'plan'];
    }

    if (intent === 'skill') {
      return ['task'];
    }

    // Unknown intent — default task + plan
    return ['task', 'plan'];
  }

  _cacheKey(ctx) {
    return crypto
      .createHash('sha256')
      .update(`${ctx.command}::${ctx.mode}::${JSON.stringify(ctx.options.steps || [])}`)
      .digest('hex')
      .slice(0, 16);
  }

  // ---------- PIPELINE EXECUTION ----------
  async _runPipeline(ctx) {
    const results = {};

    for (const step of ctx.pipeline) {
      ctx.steps[step] = { status: 'running', startedAt: nowIso() };

      try {
        const value = await this._runStep(step, ctx);
        results[step] = value;
        ctx.steps[step].status = 'done';
        ctx.steps[step].durationMs = Date.now() - new Date(ctx.steps[step].startedAt).getTime();

        this.emit('brain:step_done', { opId: ctx.opId, step, durationMs: ctx.steps[step].durationMs });

      } catch (err) {
        ctx.steps[step].status = 'failed';
        ctx.steps[step].error = err.message;
        ctx.errors.push({ step, message: err.message });

        log('warn', 'step failed', { opId: ctx.opId, step, err: err.message });
        this.emit('brain:step_error', { opId: ctx.opId, step, error: err.message });

        if (ctx.options.stopOnError) break;
      }
    }

    return results;
  }

  // ---------- STEP RUNNERS ----------
  async _runStep(step, ctx) {
    const runner = this._stepRunners[step];
    if (!runner) throw new Error(`Unknown step: ${step}`);

    // Circuit breaker
    const breaker = breakers[step];
    if (breaker && !breaker.canExecute()) {
      throw new Error(`Circuit breaker OPEN for step "${step}"`);
    }

    try {
      const value = await retry(
        () => withTimeout(runner.call(this, ctx), 60000, step),
        CONFIG.enableRetry ? CONFIG.maxRetries : 0,
        CONFIG.retryDelayMs
      );
      breaker?.success();
      return value;
    } catch (err) {
      breaker?.fail();
      throw err;
    }
  }

  // ---------- REGISTER STEP RUNNERS ----------
  get _stepRunners() {
    return {
      task: async (ctx) => {
        const res = await taskAgent.execute(ctx.command, {
          user: ctx.user,
          dryRun: ctx.dryRun,
          ...ctx.options.taskOptions,
        });
        return res;
      },

      plan: async (ctx) => {
        // Reuse task result's report if available to avoid re-scan
        const taskRes = ctx.steps.task?.status === 'done' ? ctx._taskResult : null;
        const report = taskRes?.result?.report;

        const plan = await plannerAgent.plan({
          report: report || undefined,
          maxPriority: ctx.options.maxPriority,
          phases: ctx.options.phases,
          limit: ctx.options.limit,
        });

        // Auto-check: if plan has zero tasks, skip evolution
        ctx._skipEvolution = plan.summary?.total === 0;
        return plan;
      },

      evolution: async (ctx) => {
        if (ctx._skipEvolution) {
          return { skipped: true, reason: 'No tasks to evolve' };
        }

        // Pass plan through to avoid recomputation
        const plan = ctx.steps.plan?.status === 'done' ? ctx._planResult : null;

        const rm = await evolutionAgent.evolve({
          plan: plan || undefined,
          maxPriority: ctx.options.maxPriority,
          phases: ctx.options.phases,
          limit: ctx.options.limit,
          requireApproval: ctx.options.requireApproval ?? true,
        });

        return rm;
      },

      status: async () => buildStatus(),

      skill: async (ctx) => {
        // If command mentions "add skill X"
        const match = ctx.command.match(/\bskill\s+([\w.\-]+)/i);
        if (match) {
          return skillBuilder.saveSkill(match[1], ctx.options.skillsDir, {
            template: ctx.options.template || 'basic',
            category: ctx.options.category || 'user',
          });
        }
        return skillBuilder.listSkills();
      },
    };
  }

  // ---------- RESULT RECORDING ----------
  _record(ctx, final) {
    const durationMs = final.durationMs;
    this.stats.totalDurationMs += durationMs;
    this.stats.avgDurationMs = +(this.stats.totalDurationMs / this.stats.total).toFixed(1);
    if (final.ok) this.stats.success++;

    const intent = ctx.intent.intent || 'unknown';
    this.stats.byIntent[intent] = (this.stats.byIntent[intent] || 0) + 1;
    this.stats.byMode[ctx.mode] = (this.stats.byMode[ctx.mode] || 0) + 1;

    this.history.push({
      opId: ctx.opId,
      command: ctx.command,
      intent,
      mode: ctx.mode,
      ok: final.ok,
      durationMs,
      time: final.timestamp,
    });
    if (this.history.length > CONFIG.maxHistory) {
      this.history = this.history.slice(-CONFIG.maxHistory);
    }
  }

  // ---------- PARALLEL PROCESS ----------
  async processParallel(commands, options = {}) {
    const limit = CONFIG.parallel.maxConcurrency;
    const results = [];
    for (let i = 0; i < commands.length; i += limit) {
      const batch = commands.slice(i, i + limit);
      const batchResults = await Promise.all(
        batch.map((c) => this.process(c, options))
      );
      results.push(...batchResults);
    }
    return results;
  }

  // ---------- CONVENIENCE METHODS ----------
  async analyze(command = 'scan project', options = {}) {
    return this.process(command, { ...options, mode: 'fast' });
  }

  async plan(command = 'plan next steps', options = {}) {
    return this.process(command, { ...options, mode: 'plan' });
  }

  async evolve(command = 'evolve project', options = {}) {
    return this.process(command, { ...options, mode: 'full' });
  }

  async dryRun(command, options = {}) {
    return this.process(command, { ...options, dryRun: true, mode: 'safe' });
  }

  // ---------- QUERY ----------
  getStats() {
    return {
      ...this.stats,
      successRate: this.stats.total > 0
        ? +((this.stats.success / this.stats.total) * 100).toFixed(2)
        : 0,
      historySize: this.history.length,
      cacheSize: cache.size,
    };
  }

  getHistory(limit = 20) {
    return this.history.slice(-limit).reverse();
  }

  getBreakers() {
    return Object.values(breakers).map((b) => b.snapshot());
  }

  getPipelines() {
    return PIPELINES;
  }

  getIntents() {
    return Object.keys(INTENT_PATTERNS);
  }

  // ---------- MAINTENANCE ----------
  clearCache() {
    cacheClear();
    this.emit('brain:cache_cleared');
    return { ok: true };
  }

  resetStats() {
    this.stats = {
      total: 0, success: 0, failed: 0, cached: 0,
      byIntent: {}, byMode: {}, avgDurationMs: 0, totalDurationMs: 0,
    };
    this.history = [];
    this.emit('brain:stats_reset');
    return { ok: true };
  }

  resetBreakers() {
    for (const b of Object.values(breakers)) {
      b.failures = 0;
      b.state = 'closed';
      b.openedAt = null;
    }
    return { ok: true };
  }

  // ---------- HEALTH ----------
  async health() {
    const report = {
      ok: true,
      brain: 'online',
      components: {},
    };

    // Check TaskAgent
    try {
      if (typeof taskAgent.execute === 'function') {
        report.components.taskAgent = { ok: true };
      } else {
        report.components.taskAgent = { ok: false, error: 'execute() missing' };
        report.ok = false;
      }
    } catch (err) {
      report.components.taskAgent = { ok: false, error: err.message };
      report.ok = false;
    }

    // Check PlannerAgent
    try {
      if (typeof plannerAgent.plan === 'function') {
        report.components.plannerAgent = { ok: true };
      } else {
        report.components.plannerAgent = { ok: false, error: 'plan() missing' };
        report.ok = false;
      }
    } catch (err) {
      report.components.plannerAgent = { ok: false, error: err.message };
      report.ok = false;
    }

    // Check EvolutionAgent
    try {
      if (typeof evolutionAgent.evolve === 'function') {
        report.components.evolutionAgent = { ok: true };
      } else {
        report.components.evolutionAgent = { ok: false, error: 'evolve() missing' };
        report.ok = false;
      }
    } catch (err) {
      report.components.evolutionAgent = { ok: false, error: err.message };
      report.ok = false;
    }

    // Memory
    try {
      const mem = await memoryManager.loadMemory();
      report.components.memory = {
        ok: true,
        skills: mem.learnedSkills?.length || 0,
        history: mem.projectHistory?.length || 0,
      };
    } catch (err) {
      report.components.memory = { ok: false, error: err.message };
      report.ok = false;
    }

    report.breakers = this.getBreakers();
    report.uptimeSec = Math.floor(process.uptime());
    report.time = nowIso();

    return report;
  }
}

// ============ MONKEY-PATCH STEP RESULT STORAGE ============
// Store step results on ctx so later steps can reuse them
// (task result for plan, plan result for evolution)
const _origRunStep = BrainController.prototype._runStep;
BrainController.prototype._runStep = async function (step, ctx) {
  const value = await _origRunStep.call(this, step, ctx);

  // Store for downstream reuse
  if (step === 'task') ctx._taskResult = value;
  if (step === 'plan') ctx._planResult = value;

  return value;
};

// ============ EXPORT ============
const brain = new BrainController();
brain.classifyIntent = classifyIntent;
brain.CONFIG = CONFIG;
brain.PIPELINES = PIPELINES;
brain.INTENT_PATTERNS = INTENT_PATTERNS;

module.exports = brain;

