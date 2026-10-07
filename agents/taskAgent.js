const EventEmitter = require('events');
const crypto = require('crypto');
const selfAnalyzer = require('../core/selfAnalyzer');
const memoryManager = require('../core/memoryManager');

// ============ CONFIG ============
const CONFIG = {
  maxHistory: 200,
  defaultTimeoutMs: 30000,
  enableRetry: true,
  maxRetries: 2,
  retryDelayMs: 500,
  logCommands: true,
  logLevel: process.env.LOG_LEVEL || 'info',
};

// ============ INTENT DEFINITIONS ============
// Each intent = { name, patterns, keywords, weight, handler }
// Higher weight = higher priority when multiple match
const INTENTS = [
  {
    name: 'analyze',
    description: 'Run project analysis / scan',
    patterns: [
      /\b(scan|analyze|analyse|inspect|audit|review)\b/i,
      /\bproject\s+(health|status|report)\b/i,
    ],
    keywords: ['scan', 'analyze', 'project', 'report', 'audit', 'health'],
    weight: 10,
    handler: async (ctx) => {
      const report = selfAnalyzer.analyze({ deep: ctx.deep !== false });
      if (ctx.save !== false) {
        await memoryManager.addProjectScan(report);
      }
      return { report };
    },
  },
  {
    name: 'fix-bug',
    description: 'Detect & suggest fixes for bugs',
    patterns: [
      /\b(fix|repair|resolve|patch|debug)\b/i,
      /\bbug\b/i,
    ],
    keywords: ['fix', 'bug', 'repair', 'debug', 'error'],
    weight: 8,
    handler: async (ctx) => {
      // Placeholder — wire your real bug-fixer here
      return {
        status: 'not_connected',
        message: 'Bug fixing module not connected yet.',
        suggestion: 'Connect core/bugFixer module',
      };
    },
  },
  {
    name: 'skill-manage',
    description: 'List, add, or remove skills',
    patterns: [
      /\b(skill|skills|capability|capabilities|ability)\b/i,
    ],
    keywords: ['skill', 'skills', 'capability', 'ability', 'learn'],
    weight: 7,
    handler: async (ctx) => {
      const action = ctx.action || 'list';

      if (action === 'list' || action === 'show') {
        const mem = await memoryManager.loadMemory();
        return {
          action: 'list',
          skills: mem.learnedSkills,
          count: mem.learnedSkills.length,
        };
      }

      if (action === 'add' && ctx.skill) {
        const skills = await memoryManager.addSkill({
          name: ctx.skill,
          category: ctx.category || 'user',
          source: 'task-agent',
        });
        return { action: 'add', skill: ctx.skill, total: skills.length };
      }

      if (action === 'remove' && ctx.skill) {
        const removed = await memoryManager.removeSkill(ctx.skill);
        return { action: 'remove', skill: ctx.skill, removed };
      }

      return {
        action: 'info',
        message: 'Skill module — available actions: list, add, remove',
        examples: ['list skills', 'add skill pdfReader', 'remove skill pdfReader'],
      };
    },
  },
  {
    name: 'memory-stats',
    description: 'Show memory statistics & trends',
    patterns: [
      /\b(memory|brain|stats|statistics|trend|history)\b/i,
    ],
    keywords: ['memory', 'brain', 'stats', 'trend', 'history', 'score'],
    weight: 6,
    handler: async (ctx) => {
      const stats = memoryManager.getMemoryStats();
      const trend = memoryManager.getScoreTrend(10);
      return { stats, trend };
    },
  },
  {
    name: 'export',
    description: 'Export memory / report',
    patterns: [
      /\b(export|download|dump|backup)\b/i,
    ],
    keywords: ['export', 'download', 'dump', 'backup'],
    weight: 5,
    handler: async (ctx) => {
      const format = ctx.format || 'json';
      return {
        format,
        data: memoryManager.exportMemory(format),
      };
    },
  },
  {
    name: 'reset',
    description: 'Reset memory (dangerous)',
    patterns: [
      /\b(reset|clear|wipe|purge)\b.*\b(memory|brain|history)\b/i,
      /\bforget\b/i,
    ],
    keywords: ['reset', 'clear', 'wipe', 'forget', 'purge'],
    weight: 9,
    permissions: ['admin'],
    handler: async (ctx) => {
      await memoryManager.resetMemory(ctx.keepBackups !== false);
      return { status: 'reset', keepBackups: ctx.keepBackups !== false };
    },
  },
  {
    name: 'help',
    description: 'Show available commands',
    patterns: [
      /\b(help|commands|what can you do|usage)\b/i,
    ],
    keywords: ['help', 'commands', 'usage'],
    weight: 11,
    handler: async () => ({
      commands: INTENTS.map((i) => ({
        name: i.name,
        description: i.description,
        examples: i.examples || [],
      })),
    }),
  },
  {
    name: 'status',
    description: 'Agent status / ping',
    patterns: [
      /\b(status|ping|alive|are you (there|ok))\b/i,
    ],
    keywords: ['status', 'ping', 'alive'],
    weight: 4,
    handler: async () => ({
      agent: 'TaskAgent',
      status: 'online',
      uptimeSec: Math.floor(process.uptime()),
      pid: process.pid,
    }),
  },
];

// ============ COMMAND PARSER (NLP-lite) ============
function parseCommand(raw) {
  const text = String(raw || '').trim();
  const lower = text.toLowerCase();

  // Extract key=value params: "scan deep=false save=false"
  const params = {};
  const paramRe = /(\w+)\s*[:=]\s*("([^"]*)"|'([^']*)'|(\S+))/g;
  let m;
  while ((m = paramRe.exec(text))) {
    const key = m[1].toLowerCase();
    const val = m[3] ?? m[4] ?? m[5];
    params[key] = coerce(val);
  }

  // Detect action verb (list/add/remove/export/...)
  let action = null;
  if (/\b(list|show|display|get)\b/i.test(lower)) action = 'list';
  else if (/\b(add|learn|create|register)\b/i.test(lower)) action = 'add';
  else if (/\b(remove|delete|forget|drop)\b/i.test(lower)) action = 'remove';
  else if (/\b(reset|clear|wipe|purge)\b/i.test(lower)) action = 'reset';
  else if (/\b(export|download|dump)\b/i.test(lower)) action = 'export';

  // Extract skill name after "skill"
  let skill = null;
  const skillMatch = text.match(/\bskill\s+([\w.\-]+)/i);
  if (skillMatch) skill = skillMatch[1];

  return {
    raw: text,
    lower,
    tokens: lower.split(/\s+/).filter(Boolean),
    params,
    action,
    skill,
    format: params.format || null,
  };
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

// ============ INTENT MATCHER ============
function matchIntent(parsed) {
  const scores = [];

  for (const intent of INTENTS) {
    let score = 0;

    // Pattern matches (strong signal)
    for (const p of intent.patterns) {
      if (p.test(parsed.raw)) score += 5;
    }

    // Keyword matches
    for (const kw of intent.keywords) {
      if (parsed.tokens.includes(kw)) score += 2;
      else if (parsed.lower.includes(kw)) score += 1;
    }

    // Boost by weight
    score += intent.weight;

    if (score > 0) scores.push({ intent, score });
  }

  scores.sort((a, b) => b.score - a.score);
  return scores;
}

// ============ MIDDLEWARE PIPELINE ============
const middlewares = [];

function use(fn) {
  middlewares.push(fn);
}

async function runMiddlewares(ctx, handler) {
  let idx = -1;
  const dispatch = async (i) => {
    if (i <= idx) throw new Error('next() called multiple times');
    idx = i;
    const mw = middlewares[i];
    if (!mw) return handler(ctx);
    await mw(ctx, () => dispatch(i + 1));
  };
  return dispatch(0);
}

// Built-in middlewares
use(async (ctx, next) => {
  // Logging
  if (CONFIG.logCommands) {
    console.log(`[TaskAgent] exec "${ctx.parsed.raw}" → ${ctx.intent?.name || 'unknown'}`);
  }
  ctx.startedAt = Date.now();
  await next();
});

use(async (ctx, next) => {
  // Permission check
  const perms = ctx.intent?.permissions || [];
  const userPerms = ctx.user?.permissions || ['user'];
  const ok = perms.every((p) => userPerms.includes(p) || userPerms.includes('admin'));
  if (!ok) {
    throw Object.assign(new Error('Permission denied'), {
      code: 'PERMISSION_DENIED',
      required: perms,
    });
  }
  await next();
});

use(async (ctx, next) => {
  // Timeout wrapper
  const timeout = ctx.timeoutMs || CONFIG.defaultTimeoutMs;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Task timeout after ${timeout}ms`)),
      timeout
    );
  });
  try {
    await Promise.race([next(), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
});

// ============ TASK AGENT ============
class TaskAgent extends EventEmitter {
  constructor() {
    super();
    this.history = [];
    this.running = new Map();  // in-flight tasks
    this.stats = {
      total: 0,
      success: 0,
      failed: 0,
      byIntent: {},
    };
  }

  // ---------- REGISTER INTENT (plugin API) ----------
  register(intent) {
    if (!intent?.name || typeof intent.handler !== 'function') {
      throw new Error('Intent must have name & handler');
    }
    INTENTS.push({ weight: 5, patterns: [], keywords: [], ...intent });
    this.emit('intent:registered', intent.name);
    return this;
  }

  // ---------- MAIN EXECUTE ----------
  async execute(command, options = {}) {
    const taskId = crypto.randomBytes(6).toString('hex');

    const ctx = {
      taskId,
      command,
      options,
      parsed: parseCommand(command),
      user: options.user || { id: 'anonymous', permissions: ['user', 'admin'] },
      timeoutMs: options.timeoutMs,
      deep: options.deep,
      save: options.save,
      ...options,   // allow flags like deep, save, format
    };

    this.stats.total++;

    try {
      // 1) Match intent
      const matches = matchIntent(ctx.parsed);

      if (matches.length === 0) {
        return this._finish(taskId, {
          ok: false,
          type: 'unknown',
          command,
          result: 'Command not recognized.',
          suggestion: 'Try "help" to see available commands.',
          matches: [],
        });
      }

      const { intent, score } = matches[0];
      ctx.intent = intent;
      ctx.confidence = score;
      ctx.alternatives = matches.slice(1, 4).map((m) => ({
        name: m.intent.name,
        score: m.score,
      }));

      this.emit('task:start', { taskId, intent: intent.name, command });

      // 2) Dry run?
      if (options.dryRun) {
        return this._finish(taskId, {
          ok: true,
          type: intent.name,
          dryRun: true,
          intent: intent.name,
          confidence: score,
          parsed: ctx.parsed,
          alternatives: ctx.alternatives,
          result: `Would run: ${intent.description}`,
        });
      }

      // 3) Execute through middleware pipeline with retry
      const runner = () => runMiddlewares(ctx, () => intent.handler(ctx));

      const result = CONFIG.enableRetry
        ? await this._retry(runner, CONFIG.maxRetries)
        : await runner();

      return this._finish(taskId, {
        ok: true,
        type: intent.name,
        intent: intent.name,
        confidence: score,
        durationMs: Date.now() - ctx.startedAt,
        alternatives: ctx.alternatives,
        result,
      });

    } catch (err) {
      this.stats.failed++;
      this.emit('task:error', { taskId, error: err.message });

      return this._finish(taskId, {
        ok: false,
        type: 'error',
        command,
        error: err.message,
        code: err.code || 'EXECUTION_ERROR',
        ...(err.required && { required: err.required }),
      });
    }
  }

  // ---------- RETRY WRAPPER ----------
  async _retry(fn, retries) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        return await fn();
      } catch (err) {
        // Don't retry auth/permission/timeout errors
        if (['PERMISSION_DENIED', 'TIMEOUT'].includes(err.code)) throw err;
        if (/timeout/i.test(err.message)) throw err;

        lastErr = err;
        if (i < retries) {
          await new Promise((r) => setTimeout(r, CONFIG.retryDelayMs * (i + 1)));
        }
      }
    }
    throw lastErr;
  }

  // ---------- FINISH & HISTORY ----------
  _finish(taskId, payload) {
    const entry = {
      taskId,
      time: new Date().toISOString(),
      ok: payload.ok,
      type: payload.type,
      command: payload.command,
      durationMs: payload.durationMs,
    };

    this.history.push(entry);
    if (this.history.length > CONFIG.maxHistory) {
      this.history = this.history.slice(-CONFIG.maxHistory);
    }

    // Stats
    if (payload.ok) this.stats.success++;
    const key = payload.type || 'unknown';
    this.stats.byIntent[key] = (this.stats.byIntent[key] || 0) + 1;

    this.emit('task:done', entry);

    return { ...payload, taskId };
  }

  // ---------- HELPERS ----------
  getHistory(limit = 20) {
    return this.history.slice(-limit).reverse();
  }

  getStats() {
    const total = this.stats.total || 1;
    return {
      ...this.stats,
      successRate: +((this.stats.success / total) * 100).toFixed(2),
      historySize: this.history.length,
    };
  }

  listIntents() {
    return INTENTS.map((i) => ({
      name: i.name,
      description: i.description,
      permissions: i.permissions || [],
      weight: i.weight,
    }));
  }

  // ---------- BATCH EXECUTE ----------
  async executeAll(commands, options = {}) {
    const results = [];
    for (const cmd of commands) {
      results.push(await this.execute(cmd, options));
    }
    return results;
  }

  // ---------- PARALLEL EXECUTE ----------
  async executeParallel(commands, options = {}) {
    return Promise.all(commands.map((c) => this.execute(c, options)));
  }
}

// ============ EXPORT (singleton) ============
const agent = new TaskAgent();
agent.INTENTS = INTENTS;
agent.parseIntentCommand = parseCommand;

module.exports = agent;