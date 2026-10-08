const EventEmitter = require('events');
const crypto = require('crypto');
const selfAnalyzer = require('../core/selfAnalyzer');
const memoryManager = require('../core/memoryManager');

// ============ CONFIG ============
const CONFIG = {
  maxHistory: 200,
  maxConversationTurns: 10,
  defaultTimeoutMs: 30000,
  enableRetry: true,
  maxRetries: 2,
  retryDelayMs: 500,
  logCommands: true,
  logLevel: process.env.LOG_LEVEL || 'info',
  enableCache: true,
  cacheTTLMs: 60000,
  rateLimit: { windowMs: 60000, max: 30 },
  groqModel: process.env.GROQ_MODEL || 'Openai/gpt-oss-20b', 
};

// ============ SESSION STORE (multi-user) ============
class SessionStore {
  constructor(max = 500) {
    this.sessions = new Map();
    this.max = max;
  }
  get(userId = 'default') {
    if (!this.sessions.has(userId)) {
      this.sessions.set(userId, {
        userId,
        turns: [],           
        entities: {},         
        lastIntent: null,
        mood: 'neutral',
        createdAt: Date.now(),
        requestTimes: [],
      });
      if (this.sessions.size > this.max) {
        const oldest = [...this.sessions.keys()][0];
        this.sessions.delete(oldest);
      }
    }
    return this.sessions.get(userId);
  }
  addTurn(userId, role, content) {
    const s = this.get(userId);
    s.turns.push({ role, content, ts: Date.now() });
    if (s.turns.length > CONFIG.maxConversationTurns * 2) {
      s.turns = s.turns.slice(-CONFIG.maxConversationTurns * 2);
    }
    return s;
  }
  clear(userId) { this.sessions.delete(userId); }
}
const sessionStore = new SessionStore();

// ============ SMART CACHE ============
class SmartCache {
  constructor(ttl = CONFIG.cacheTTLMs) {
    this.map = new Map();
    this.ttl = ttl;
  }
  key(cmd) { return crypto.createHash('md5').update(cmd.toLowerCase().trim()).digest('hex'); }
  get(cmd) {
    if (!CONFIG.enableCache) return null;
    const k = this.key(cmd);
    const v = this.map.get(k);
    if (!v) return null;
    if (Date.now() - v.ts > this.ttl) { this.map.delete(k); return null; }
    return v.data;
  }
  set(cmd, data) {
    if (!CONFIG.enableCache) return;
    this.map.set(this.key(cmd), { data, ts: Date.now() });
    if (this.map.size > 200) this.map.delete(this.map.keys().next().value);
  }
}
const cache = new SmartCache();

// ============ RATE LIMITER ============
function checkRateLimit(session) {
  const now = Date.now();
  session.requestTimes = session.requestTimes.filter(t => now - t < CONFIG.rateLimit.windowMs);
  if (session.requestTimes.length >= CONFIG.rateLimit.max) {
    throw Object.assign(new Error('Rate limit exceeded. Thoda ruko Boss.'), { code: 'RATE_LIMIT' });
  }
  session.requestTimes.push(now);
}

// ============ ENTITY EXTRACTION ============
function extractEntities(text) {
  const entities = {};
  const files = text.match(/\b[\w\-]+\.(js|json|py|md|txt|env|html|css|ts)\b/gi);
  if (files) entities.files = files;
  const nums = text.match(/\b\d+(\.\d+)?\b/g);
  if (nums) entities.numbers = nums.map(Number);
  const quoted = [...text.matchAll(/["']([^"']+)["']/g)].map(m => m[1]);
  if (quoted.length) entities.quoted = quoted;
  const urls = text.match(/https?:\/\/\S+/g);
  if (urls) entities.urls = urls;
  const emails = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g);
  if (emails) entities.emails = emails;
  return entities;
}

// ============ SENTIMENT & URGENCY ============
function analyzeSentiment(text) {
  const lower = text.toLowerCase();
  const urgent = /\b(jaldi|urgent|fast|quickly|asap|turant|abhi)\b/.test(lower);
  const angry = /\b(bakwas|kharab|gussa|frustrat|annoy|stupid|worst)\b/.test(lower);
  const happy = /\b(shabash|badhiya|great|awesome|perfect|thanks|dhanyavad)\b/.test(lower);
  const confused = /\b(samajh nahi|confus|kya matlab|nahi samjha)\b/.test(lower);

  let mood = 'neutral';
  if (angry) mood = 'angry';
  else if (happy) mood = 'positive';
  else if (confused) mood = 'confused';

  return { mood, urgent, angry, happy, confused };
}

// ============ FUZZY MATCH ============
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}
function fuzzyIncludes(token, keyword) {
  if (token === keyword) return true;
  if (Math.abs(token.length - keyword.length) > 2) return false;
  return levenshtein(token, keyword) <= 1;
}

// ============ GROQ AI WITH TOOL CALLING ============
async function askGroqAI(prompt, session = null, options = {}) {
  if (!process.env.GROQ_API_KEY) {
    return "Boss, GROQ_API_KEY set nahi hai. .env check karo.";
  }

  try {
    const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const mood = session?.mood || 'neutral';
    const context = (session?.turns || []).slice(-CONFIG.maxConversationTurns)
      .map(t => `${t.role === 'user' ? 'Boss' : 'Nexus'}: ${t.content}`).join('\n');

    const systemPrompt = `You are NexusManager, an elite AI assistant built by a CEO.
Personality: Loyal, sharp, concise, professional-yet-friendly.
Language: Reply in Hinglish (Hindi + English in Latin script).
Mood of user right now: ${mood}. ${mood === 'angry' ? 'Be extra calm and apologetic.' : ''}
${mood === 'confused' ? 'Explain simply with examples.' : ''}
Current time: ${now}
Keep answers short and direct. If asked to do something, confirm it clearly.`;

    const messages = [
      { role: 'system', content: systemPrompt },
    ];
    if (context) {
      messages.push({ role: 'system', content: `Previous conversation:\n${context}` });
    }
    messages.push({ role: 'user', content: prompt });

    const body = {
      model: CONFIG.groqModel,
      messages,
      temperature: options.temperature ?? 0.6,
      max_tokens: options.maxTokens ?? 512,
    };

    if (options.tools) body.tools = options.tools;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    if (data.error) return `Boss, AI Error: ${data.error.message}`;

    const choice = data.choices?.[0];
    if (!choice) return "Samajh nahi aaya Boss, AI ne kuch nahi bola.";

    if (choice.message?.tool_calls?.length) {
      return { toolCalls: choice.message.tool_calls, raw: choice.message.content };
    }

    return choice.message.content || "Kuch nahi bola AI ne.";
  } catch (err) {
    return `Boss, connection issue: ${err.message}`;
  }
}

// ============ INTENTS ============
const INTENTS = [
  {
    name: 'analyze',
    description: 'Run project analysis / scan',
    patterns: [/\b(scan|analyze|analyse|inspect|audit|review)\b/i, /\bproject\s+(health|status|report)\b/i],
    keywords: ['scan', 'analyze', 'project', 'report', 'audit', 'health'],
    weight: 10,
    examples: ['scan project', 'analyze deep:true'],
    handler: async (ctx) => {
      const report = selfAnalyzer.analyze({ deep: ctx.deep !== false });
      if (ctx.save !== false) await memoryManager.addProjectScan(report);
      return { report };
    },
  },
  {
    name: 'fix-bug',
    description: 'Detect & suggest fixes',
    patterns: [/\b(fix|repair|resolve|patch|debug)\b/i, /\bbug\b/i],
    keywords: ['fix', 'bug', 'repair', 'debug', 'error'],
    weight: 8,
    examples: ['fix bug in server.js'],
    handler: async () => ({
      status: 'not_connected',
      message: 'Bug fixing module not connected yet.',
      suggestion: 'Connect core/bugFixer module',
    }),
  },
  {
    name: 'skill-manage',
    description: 'List, add, or remove skills',
    patterns: [/\b(skill|skills|capability|capabilities|ability)\b/i],
    keywords: ['skill', 'skills', 'capability', 'ability', 'learn'],
    weight: 7,
    examples: ['list skills', 'add skill pdfReader'],
    handler: async (ctx) => {
      const action = ctx.action || 'list';
      if (action === 'list' || action === 'show') {
        const mem = await memoryManager.loadMemory();
        return { action: 'list', skills: mem.learnedSkills, count: mem.learnedSkills.length };
      }
      if (action === 'add' && ctx.skill) {
        const skills = await memoryManager.addSkill({ name: ctx.skill, category: ctx.category || 'user', source: 'task-agent' });
        return { action: 'add', skill: ctx.skill, total: skills.length };
      }
      if (action === 'remove' && ctx.skill) {
        const removed = await memoryManager.removeSkill(ctx.skill);
        return { action: 'remove', skill: ctx.skill, removed };
      }
      return { action: 'info', message: 'Actions: list, add, remove', examples: ['list skills'] };
    },
  },
  {
    name: 'memory-stats',
    description: 'Show memory statistics',
    patterns: [/\b(memory|brain|stats|statistics|trend|history)\b/i],
    keywords: ['memory', 'brain', 'stats', 'trend', 'history', 'score'],
    weight: 6,
    examples: ['memory stats'],
    handler: async () => ({ stats: memoryManager.getMemoryStats(), trend: memoryManager.getScoreTrend(10) }),
  },
  {
    name: 'export',
    description: 'Export memory / report',
    patterns: [/\b(export|download|dump|backup)\b/i],
    keywords: ['export', 'download', 'dump', 'backup'],
    weight: 5,
    examples: ['export format:json'],
    handler: async (ctx) => ({ format: ctx.format || 'json', data: memoryManager.exportMemory(ctx.format || 'json') }),
  },
  {
    name: 'reset',
    description: 'Reset memory (dangerous)',
    patterns: [/\b(reset|clear|wipe|purge)\b.*\b(memory|brain|history)\b/i, /\bforget\b/i],
    keywords: ['reset', 'clear', 'wipe', 'forget', 'purge'],
    weight: 9,
    permissions: ['admin'],
    examples: ['reset memory'],
    handler: async (ctx) => {
      await memoryManager.resetMemory(ctx.keepBackups !== false);
      return { status: 'reset', keepBackups: ctx.keepBackups !== false };
    },
  },
  {
    name: 'help',
    description: 'Show available commands',
    patterns: [/\b(help|commands|what can you do|usage)\b/i],
    keywords: ['help', 'commands', 'usage'],
    weight: 11,
    examples: ['help'],
    handler: async () => ({ commands: INTENTS.map(i => ({ name: i.name, description: i.description, examples: i.examples || [] })) }),
  },
  {
    name: 'status',
    description: 'Agent status / ping',
    patterns: [/\b(status|ping|alive|are you (there|ok))\b/i],
    keywords: ['status', 'ping', 'alive'],
    weight: 4,
    examples: ['status'],
    handler: async () => ({ agent: 'TaskAgent', status: 'online', uptimeSec: Math.floor(process.uptime()), pid: process.pid }),
  },
];

// ============ PARSER ============
function parseCommand(raw) {
  const text = String(raw || '').trim();
  const lower = text.toLowerCase();
  const params = {};
  const paramRe = /(\w+)\s*[:=]\s*("([^"]*)"|'([^']*)'|(\S+))/g;
  let m;
  while ((m = paramRe.exec(text))) {
    const key = m[1].toLowerCase();
    const val = m[3] ?? m[4] ?? m[5];
    params[key] = coerce(val);
  }

  let action = null;
  if (/\b(list|show|display|get)\b/i.test(lower)) action = 'list';
  else if (/\b(add|learn|create|register)\b/i.test(lower)) action = 'add';
  else if (/\b(remove|delete|forget|drop)\b/i.test(lower)) action = 'remove';
  else if (/\b(reset|clear|wipe|purge)\b/i.test(lower)) action = 'reset';
  else if (/\b(export|download|dump)\b/i.test(lower)) action = 'export';

  let skill = null;
  const skillMatch = text.match(/\bskill\s+([\w.\-]+)/i);
  if (skillMatch) skill = skillMatch[1];

  return {
    raw: text, lower,
    tokens: lower.split(/\s+/).filter(Boolean),
    params, action, skill,
    format: params.format || null,
    entities: extractEntities(text),
    sentiment: analyzeSentiment(text),
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

// ============ MATCHER ============
function matchIntent(parsed, returnAll = false) {
  const scores = [];
  for (const intent of INTENTS) {
    let score = 0;
    
    for (const p of intent.patterns) {
      if (p.test(parsed.raw)) score += 5;
    }
    
    for (const kw of intent.keywords) {
      if (parsed.tokens.some(t => fuzzyIncludes(t, kw))) score += 2;
      else if (parsed.lower.includes(kw)) score += 1;
    }
    
    // 🔥 FIX YAHAN LAGA HAI: Intent ka weight tabhi add hoga jab sach mein kuch match ho
    if (score > 0) {
      score += intent.weight;
      scores.push({ intent, score });
    }
  }
  scores.sort((a, b) => b.score - a.score);
  return returnAll ? scores : scores[0] ? [scores[0]] : [];
}

// ============ MIDDLEWARE ============
const middlewares = [];
function use(fn) { middlewares.push(fn); }

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

use(async (ctx, next) => {
  if (CONFIG.logCommands) console.log(`[TaskAgent] exec "${ctx.parsed.raw}" → ${ctx.intent?.name || 'chat'}`);
  ctx.startedAt = Date.now();
  await next();
});

use(async (ctx, next) => {
  const perms = ctx.intent?.permissions || [];
  const userPerms = ctx.user?.permissions || ['user'];
  const ok = perms.every(p => userPerms.includes(p) || userPerms.includes('admin'));
  if (!ok) throw Object.assign(new Error('Permission denied'), { code: 'PERMISSION_DENIED', required: perms });
  await next();
});

use(async (ctx, next) => {
  const timeout = ctx.timeoutMs || CONFIG.defaultTimeoutMs;
  let timer;
  const timeoutPromise = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Task timeout ${timeout}ms`)), timeout); });
  try { await Promise.race([next(), timeoutPromise]); } finally { clearTimeout(timer); }
});

// ============ TASK AGENT ============
class TaskAgent extends EventEmitter {
  constructor() {
    super();
    this.history = [];
    this.running = new Map();
    this.stats = { total: 0, success: 0, failed: 0, byIntent: {}, cacheHits: 0 };
  }

  register(intent) {
    if (!intent?.name || typeof intent.handler !== 'function') throw new Error('Intent needs name & handler');
    INTENTS.push({ weight: 5, patterns: [], keywords: [], examples: [], ...intent });
    this.emit('intent:registered', intent.name);
    return this;
  }

  clearSession(userId) { sessionStore.clear(userId); }

  async execute(command, options = {}) {
    const taskId = crypto.randomBytes(6).toString('hex');
    const userId = options.user?.id || 'default';
    const session = sessionStore.get(userId);

    try { checkRateLimit(session); }
    catch (err) {
      return { taskId, ok: false, type: 'error', error: err.message, code: err.code };
    }

    const ctx = {
      taskId, command, options,
      parsed: parseCommand(command),
      user: options.user || { id: userId, permissions: ['user', 'admin'] },
      session,
      timeoutMs: options.timeoutMs, deep: options.deep, save: options.save,
      ...options,
    };

    this.stats.total++;
    session.mood = ctx.parsed.sentiment.mood;
    session.entities = { ...session.entities, ...ctx.parsed.entities };

    sessionStore.addTurn(userId, 'user', command);

    try {
      const matches = matchIntent(ctx.parsed, true);
      const isFollowUp = /\b(usko|wahi|isko|fir|phir|aur|also|continue|repeat)\b/i.test(ctx.parsed.lower);

      if (matches.length === 0 || (isFollowUp && matches[0].score < 8)) {
        const cached = cache.get(command);
        if (cached) {
          this.stats.cacheHits++;
          return this._finish(taskId, { ...cached, taskId, cached: true });
        }

        this.emit('task:start', { taskId, intent: 'chat', command });

        const aiResponse = await askGroqAI(command, session);
        
        let finalReply = aiResponse;
        if (typeof aiResponse === 'object' && aiResponse.raw) {
             finalReply = aiResponse.raw; 
        } else if (typeof aiResponse === 'object') {
             finalReply = JSON.stringify(aiResponse);
        }
        
        sessionStore.addTurn(userId, 'assistant', finalReply);

        const payload = {
          ok: true, type: 'chat', intent: 'chat', confidence: 1,
          command, durationMs: Date.now() - ctx.startedAt,
          managerReply: finalReply,
          mood: session.mood,
          entities: session.entities,
        };
        cache.set(command, payload);
        return this._finish(taskId, payload);
      }

      const primary = matches[0];
      const secondaries = matches.slice(1).filter(m => m.score >= primary.score * 0.85 && m.score > 10);

      ctx.intent = primary.intent;
      ctx.confidence = primary.score;

      this.emit('task:start', { taskId, intent: primary.intent.name, command });

      if (options.dryRun) {
        return this._finish(taskId, {
          ok: true, type: primary.intent.name, dryRun: true,
          intent: primary.intent.name, confidence: primary.score,
          parsed: ctx.parsed, result: `Would run: ${primary.intent.description}`,
        });
      }

      const runOne = async (intent) => {
        const localCtx = { ...ctx, intent };
        const runner = () => runMiddlewares(localCtx, () => intent.handler(localCtx));
        return CONFIG.enableRetry ? await this._retry(runner, CONFIG.maxRetries) : await runner();
      };

      const primaryResult = await runOne(primary.intent);

      let secondaryResults = [];
      if (secondaries.length && options.multiIntent !== false) {
        secondaryResults = await Promise.all(
          secondaries.map(async (m) => {
            try { return { name: m.intent.name, result: await runOne(m.intent) }; }
            catch (e) { return { name: m.intent.name, error: e.message }; }
          })
        );
      }

      sessionStore.addTurn(userId, 'assistant', `[Executed: ${primary.intent.name}]`);
      session.lastIntent = primary.intent.name;

      return this._finish(taskId, {
        ok: true, type: primary.intent.name, intent: primary.intent.name,
        confidence: primary.score, durationMs: Date.now() - ctx.startedAt,
        result: primaryResult,
        ...(secondaryResults.length && { alsoRan: secondaryResults }),
        mood: session.mood,
        alternatives: matches.slice(1, 4).map(m => ({ name: m.intent.name, score: m.score })),
      });

    } catch (err) {
      this.stats.failed++;
      this.emit('task:error', { taskId, error: err.message });
      return this._finish(taskId, {
        ok: false, type: 'error', command, error: err.message,
        code: err.code || 'EXECUTION_ERROR',
        ...(err.required && { required: err.required }),
      });
    }
  }

  async _retry(fn, retries) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try { return await fn(); }
      catch (err) {
        if (['PERMISSION_DENIED', 'RATE_LIMIT'].includes(err.code)) throw err;
        if (/timeout/i.test(err.message)) throw err;
        lastErr = err;
        if (i < retries) await new Promise(r => setTimeout(r, CONFIG.retryDelayMs * (i + 1)));
      }
    }
    throw lastErr;
  }

  _finish(taskId, payload) {
    const entry = {
      taskId, time: new Date().toISOString(), ok: payload.ok,
      type: payload.type, command: payload.command, durationMs: payload.durationMs,
    };
    this.history.push(entry);
    if (this.history.length > CONFIG.maxHistory) this.history = this.history.slice(-CONFIG.maxHistory);
    if (payload.ok) this.stats.success++;
    const key = payload.type || 'unknown';
    this.stats.byIntent[key] = (this.stats.byIntent[key] || 0) + 1;
    this.emit('task:done', entry);
    return { ...payload, taskId };
  }

  getHistory(limit = 20) { return this.history.slice(-limit).reverse(); }
  getStats() {
    const total = this.stats.total || 1;
    return {
      ...this.stats,
      successRate: +((this.stats.success / total) * 100).toFixed(2),
      historySize: this.history.length,
      activeSessions: sessionStore.sessions.size,
    };
  }
  listIntents() { return INTENTS.map(i => ({ name: i.name, description: i.description, permissions: i.permissions || [], weight: i.weight })); }
  async executeAll(commands, options = {}) {
    const results = [];
    for (const cmd of commands) results.push(await this.execute(cmd, options));
    return results;
  }
  async executeParallel(commands, options = {}) {
    return Promise.all(commands.map(c => this.execute(c, options)));
  }
}

const agent = new TaskAgent();
agent.INTENTS = INTENTS;
agent.parseIntentCommand = parseCommand;
agent.sessionStore = sessionStore;
module.exports = agent;
