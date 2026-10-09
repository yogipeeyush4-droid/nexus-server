// server.js — Nexus Forge Engine (Brain-Powered) — FINAL
'use strict';

require('dotenv').config();

// ============ CORE IMPORTS ============
const express       = require('express');
const helmet        = require('helmet');
const cors          = require('cors');
const compression   = require('compression');
const morgan        = require('morgan');
const rateLimit     = require('express-rate-limit');
const cluster       = require('cluster');
const os            = require('os');
const http          = require('http');
const crypto        = require('crypto');

// ============ APP MODULES ============
const taskAgent      = require('./agents/taskAgent');
const memoryManager  = require('./core/memoryManager');
const selfAnalyzer   = require('./core/selfAnalyzer');

// ============ 🧠 BRAIN MODULES (NEW) ============
const brain         = require('./core/brain/brainCore');
const goals         = require('./core/brain/goalEngine');
const codeAdvisor   = require('./core/brain/codeAdvisor');
const knowledge     = require('./core/brain/knowledgeGraph');
const strategies    = require('./core/brain/strategyEngine');
const reflection    = require('./core/brain/reflectionEngine');
const nexusCore     = require('./core/brain/nexusCore'); // 👈 NEXUS CORE ADDED HERE

// ============ CONFIG ============
const CONFIG = {
  port: parseInt(process.env.PORT, 10) || 3000,
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  workers: parseInt(process.env.WORKERS, 10) || 0,
  apiVersion: 'v1',
  bodyLimit: process.env.BODY_LIMIT || '1mb',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  apiKey: process.env.API_KEY || null,
  trustProxy: process.env.TRUST_PROXY === 'true',
  shutdownTimeout: 10000,
  rateLimit: {
    windowMs: 60 * 1000,
    max: 100,
    analyze: 10,
  },
};

// ============ LOGGER ============
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];

const logger = {
  _write(level, msg, meta) {
    if (LOG_LEVELS[level] > CURRENT_LEVEL) return;
    const entry = {
      time: new Date().toISOString(),
      level, msg, pid: process.pid,
      ...(meta && { meta }),
    };
    const out = CONFIG.isProd
      ? JSON.stringify(entry)
      : `[${entry.time}] ${level.toUpperCase().padEnd(5)} ${msg}` +
        (meta ? ` ${JSON.stringify(meta)}` : '');
    (level === 'error' ? process.stderr : process.stdout).write(out + '\n');
  },
  error(m, meta) { this._write('error', m, meta); },
  warn(m, meta)  { this._write('warn',  m, meta); },
  info(m, meta)  { this._write('info',  m, meta); },
  debug(m, meta) { this._write('debug', m, meta); },
};

// ============ METRICS ============
const metrics = {
  startedAt: Date.now(),
  requests: { total: 0, byStatus: {}, byRoute: {} },
  errors: 0,
  scans: 0,
  lastScanAt: null,

  record(res, route, durationMs) {
    this.requests.total++;
    const key = `${res.statusCode}`;
    this.requests.byStatus[key] = (this.requests.byStatus[key] || 0) + 1;

    const r = route || 'unknown';
    if (!this.requests.byRoute[r]) {
      this.requests.byRoute[r] = { count: 0, totalMs: 0, errors: 0 };
    }
    this.requests.byRoute[r].count++;
    this.requests.byRoute[r].totalMs += durationMs;
    if (res.statusCode >= 400) this.requests.byRoute[r].errors++;
  },

  snapshot() {
    const uptime = Math.floor((Date.now() - this.startedAt) / 1000);
    const mem = process.memoryUsage();
    return {
      uptimeSec: uptime,
      uptimeHuman: formatUptime(uptime),
      requests: this.requests,
      errors: this.errors,
      scans: this.scans,
      lastScanAt: this.lastScanAt,
      memory: {
        rssMB:        +(mem.rss / 1024 / 1024).toFixed(2),
        heapUsedMB:   +(mem.heapUsed / 1024 / 1024).toFixed(2),
        heapTotalMB:  +(mem.heapTotal / 1024 / 1024).toFixed(2),
        externalMB:   +(mem.external / 1024 / 1024).toFixed(2),
      },
      cpu: process.cpuUsage(),
      node: process.version,
    };
  },
};

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ');
}

// ============ REQUEST ID ============
function requestIdMiddleware(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomBytes(8).toString('hex');
  res.set('X-Request-Id', req.id);
  next();
}

// ============ API KEY AUTH ============
function apiKeyAuth(req, res, next) {
  if (!CONFIG.apiKey) return next();
  const provided =
    req.headers['x-api-key'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!provided || provided !== CONFIG.apiKey) {
    logger.warn('Auth failed', { ip: req.ip, path: req.path });
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// ============ ERROR HANDLERS ============
function errorHandler(err, req, res, _next) {
  metrics.errors++;
  logger.error('Request failed', {
    id: req.id, path: req.path, method: req.method, message: err.message,
  });
  res.status(err.status || 500).json({
    ok: false,
    error: err.message || 'Internal Server Error',
    requestId: req.id,
    ...(CONFIG.isProd ? {} : { stack: err.stack }),
  });
}

function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false, error: 'Not Found',
    path: req.path, requestId: req.id,
  });
}

// ============ ASYNC WRAPPER ============
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ============ APP ============
function createApp() {
  const app = express();

  if (CONFIG.trustProxy) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  app.use(cors({
    origin: CONFIG.corsOrigin === '*' ? true : CONFIG.corsOrigin.split(','),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-Id'],
  }));

  app.use(compression());
  app.use(express.json({ limit: CONFIG.bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: CONFIG.bodyLimit }));
  app.use(requestIdMiddleware);

  app.use(morgan(CONFIG.isProd ? 'combined' : 'dev', {
    stream: { write: (msg) => logger.info(msg.trim()) },
  }));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      metrics.record(res, req.route?.path || req.path, Date.now() - start);
    });
    next();
  });

  app.use(rateLimit({
    windowMs: CONFIG.rateLimit.windowMs,
    max: CONFIG.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'Too many requests, slow down' },
  }));

  return app;
}

// ============ ROUTES ============
function registerRoutes(app) {

  // ============================================================
  // HEALTH CHECK
  // ============================================================
  const healthHandler = (req, res) => {
    const mem = process.memoryUsage();
    res.json({
      ok: true,
      status: 'online',
      brain: 'active',
      version: require('./package.json').version,
      env: CONFIG.env,
      pid: process.pid,
      uptime: formatUptime(Math.floor((Date.now() - metrics.startedAt) / 1000)),
      memory: { heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(2) },
      time: new Date().toISOString(),
      requestId: req.id,
    });
  };

  app.get('/health', healthHandler);
  app.get('/api/v1/health', healthHandler);

  app.get('/live', (req, res) => res.json({ ok: true }));
  app.get('/ready', (req, res) => {
    try {
      memoryManager.loadMemory();
      res.json({ ok: true, ready: true });
    } catch (err) {
      res.status(503).json({ ok: false, ready: false, error: err.message });
    }
  });

  // ============================================================
  // 🔥 MAIN SWARM ROUTE — BRAIN-POWERED (UPDATED WITH NEXUS CORE)
  // ============================================================
  app.post('/api/swarm', async (req, res) => {
    try {
      const { command } = req.body;
      const cmdText = (command || '').toLowerCase().trim();

      let cleanReply = '';

      // Quick greeting shortcuts (fast path, no LLM call)
      const greetings = ['hi', 'hello', 'hey', 'namaste', 'good morning', 'good evening'];
      const howAreYou = ['kese ho', 'kaise ho', 'kya haal', 'how are you'];

      if (greetings.includes(cmdText)) {
        cleanReply = 'Hello Boss! Nexus System online hai. Bataiye kya commands hain aaj ke liye?';
      } else if (howAreYou.some(phrase => cmdText.includes(phrase))) {
        cleanReply = 'Main bilkul theek hoon Boss! Aap batayein, aaj kya kaam karna hai?';
      } else {
        
        // 🧠 1. NEXUS CORE: Process thought, extract intent, fetch cloud & local memories
        const brainThought = await nexusCore.processThought(command || '');
        
        console.log(`[NexusCore] Intent: ${brainThought.intent} | Memories Found: ${brainThought.memoriesFound}`);

        // 🧠 2. ENRICH PROMPT: Combine memory context with user command
        // Isse aapka AI purani baaton ko dhyan mein rakh kar reply karega
        const enrichedCommand = `[SYSTEM CONTEXT: User Intent is '${brainThought.intent}'. Relevant Past Memories: ${brainThought.memoryContext}]\n\nUser Input: ${command}`;

        // 🧠 3. PASS TO EXISTING AI BRAIN
        const result = await brain.think(enrichedCommand, { userId: 'ceo' });

        // Debug log
        console.log('[/api/swarm] brain result:', JSON.stringify({
          strategy: result.strategy,
          latencyMs: result.latencyMs,
          recalled: result.recalledCount,
          success: result.success,
          nexusAction: brainThought.action
        }));

        cleanReply = result.reply || 'Boss, samajh nahi aaya.';
      }

      res.json({
        status: 'success',
        managerReply: cleanReply || '[Autonomous Action Completed]',
      });

    } catch (err) {
      console.error('[/api/swarm] FATAL:', err);
      res.status(500).json({
        status: 'error',
        managerReply: `[EMERGENCY] ${err.message}`,
      });
    }
  });

  // ============================================================
  // ANALYZE ROUTE
  // ============================================================
  const analyzeLimiter = rateLimit({
    windowMs: CONFIG.rateLimit.windowMs,
    max: CONFIG.rateLimit.analyze,
    message: { ok: false, error: 'Analyze rate limit exceeded' },
  });

  app.get(
    ['/analyze', '/api/v1/analyze'],
    analyzeLimiter,
    apiKeyAuth,
    asyncHandler(async (req, res) => {
      const t0 = Date.now();
      const deep = req.query.deep !== 'false';
      const save = req.query.save !== 'false';

      const report = selfAnalyzer.analyze({ deep });
      if (save) await memoryManager.addProjectScan(report);

      metrics.scans++;
      metrics.lastScanAt = new Date().toISOString();

      logger.info('Scan complete', {
        id: req.id,
        score: report.score,
        files: report.overview?.totalFiles,
        durationMs: Date.now() - t0,
      });

      res.json({ ok: true, requestId: req.id, durationMs: Date.now() - t0, report });
    })
  );

  // ============================================================
  // MEMORY ENDPOINTS
  // ============================================================
  app.get('/api/v1/memory', apiKeyAuth, asyncHandler(async (req, res) => {
    const mem = await memoryManager.loadMemory();
    res.json({ ok: true, memory: mem });
  }));

  app.get('/api/v1/memory/stats', apiKeyAuth, asyncHandler(async (req, res) => {
    res.json({ ok: true, ...memoryManager.getMemoryStats() });
  }));

  app.get('/api/v1/memory/trend', apiKeyAuth, asyncHandler(async (req, res) => {
    const window = parseInt(req.query.window, 10) || 10;
    res.json({ ok: true, ...memoryManager.getScoreTrend(window) });
  }));

  app.get('/api/v1/memory/skills', apiKeyAuth, asyncHandler(async (req, res) => {
    const skills = req.query.category
      ? memoryManager.getSkillsByCategory(req.query.category)
      : (await memoryManager.loadMemory()).learnedSkills;
    res.json({ ok: true, count: skills.length, skills });
  }));

  app.post('/api/v1/memory/skill', apiKeyAuth, asyncHandler(async (req, res) => {
    if (!req.body || !req.body.name) {
      return res.status(400).json({ ok: false, error: 'name required' });
    }
    const skills = await memoryManager.addSkill(req.body);
    res.json({ ok: true, skills });
  }));

  app.get('/api/v1/memory/export', apiKeyAuth, asyncHandler(async (req, res) => {
    const format = req.query.format || 'json';
    const data = memoryManager.exportMemory(format);
    res.set('Content-Type', format === 'csv' ? 'text/csv' : 'application/json');
    res.set('Content-Disposition', `attachment; filename="memory.${format}"`);
    res.send(data);
  }));

  // ============================================================
  // METRICS & SYSTEM
  // ============================================================
  app.get('/api/v1/metrics', apiKeyAuth, (req, res) => {
    res.json({ ok: true, ...metrics.snapshot() });
  });

  app.get('/api/v1/system', apiKeyAuth, (req, res) => {
    res.json({
      ok: true,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      cwd: process.cwd(),
      env: CONFIG.env,
      workers: cluster.isWorker ? cluster.worker.id : 'primary',
    });
  });

  // ============================================================
  // 🧠 BRAIN ENDPOINTS
  // ============================================================

  // Full brain snapshot + natural language explanation
  app.get('/api/brain', async (req, res) => {
    try {
      const snap = brain.snapshot();
      let explain = 'Brain online hai Boss.';
      try { explain = await brain.explainSelf(); } catch (e) { /* ignore */ }
      res.json({ ok: true, snapshot: snap, explanation: explain });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Recent reasoning trace
  app.get('/api/brain/thoughts', (req, res) => {
    try {
      const limit = parseInt(req.query.limit, 10) || 20;
      const snap = brain.snapshot();
      res.json({ ok: true, thoughts: snap.thoughts.slice(-limit) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Goals list
  app.get('/api/brain/goals', (req, res) => {
    try {
      res.json({ ok: true, ...goals.stats(), list: goals.prioritized(20) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Manually add a goal
  app.post('/api/brain/goals', (req, res) => {
    try {
      const { title, description, priority, tags } = req.body || {};
      if (!title) return res.status(400).json({ ok: false, error: 'title required' });
      const r = goals.addGoal({ title, description, priority, tags, source: 'api' });
      res.json(r);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Update goal progress
  app.post('/api/brain/goals/:id/progress', (req, res) => {
    try {
      const { progress, note } = req.body || {};
      const r = goals.updateProgress(req.params.id, progress, note);
      res.json(r);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Complete a goal
  app.post('/api/brain/goals/:id/complete', (req, res) => {
    try {
      const { outcome } = req.body || {};
      const r = goals.complete(req.params.id, outcome || 'success');
      res.json(r);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Abandon a goal
  app.post('/api/brain/goals/:id/abandon', (req, res) => {
    try {
      const { reason } = req.body || {};
      const r = goals.abandon(req.params.id, reason || '');
      res.json(r);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Knowledge graph stats + search
  app.get('/api/brain/knowledge', (req, res) => {
    try {
      if (req.query.q) {
        const hits = knowledge.search(req.query.q, parseInt(req.query.limit, 10) || 5);
        return res.json({ ok: true, query: req.query.q, hits });
      }
      res.json({ ok: true, ...knowledge.stats() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Add a knowledge node manually
  app.post('/api/brain/knowledge', (req, res) => {
    try {
      const { type, content, tags, weight } = req.body || {};
      if (!content) return res.status(400).json({ ok: false, error: 'content required' });
      const r = knowledge.addNode({ type, content, tags, weight });
      res.json(r);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Strategies ranking
  app.get('/api/brain/strategies', (req, res) => {
    try {
      res.json({
        ok: true,
        ...strategies.stats(),
        ranking: strategies.ranking(req.query.category || null),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Reflections summary
  app.get('/api/brain/reflections', (req, res) => {
    try {
      res.json({ ok: true, ...reflection.summary(parseInt(req.query.last, 10) || 50) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Find similar past situations
  app.get('/api/brain/reflections/similar', (req, res) => {
    try {
      const q = req.query.q || '';
      const limit = parseInt(req.query.limit, 10) || 3;
      res.json({ ok: true, similar: reflection.findSimilar(q, limit) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Code suggestions — list
  app.get('/api/brain/code-suggestions', (req, res) => {
    try {
      const status = req.query.status || 'pending';
      res.json({ ok: true, ...codeAdvisor.stats(), list: codeAdvisor.list(status) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Ask AI to review a specific file
  app.post('/api/brain/code-suggestions', async (req, res) => {
    try {
      const { file, concern } = req.body || {};
      if (!file) return res.status(400).json({ ok: false, error: 'file required' });
      const r = await codeAdvisor.suggestFor(file, concern || '');
      res.json(r);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Approve a suggestion
  app.post('/api/brain/code-suggestions/:id/approve', (req, res) => {
    try {
      const r = codeAdvisor.approve(req.params.id, (req.body && req.body.note) || '');
      res.json(r);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Reject a suggestion
  app.post('/api/brain/code-suggestions/:id/reject', (req, res) => {
    try {
      const r = codeAdvisor.reject(req.params.id, (req.body && req.body.reason) || '');
      res.json(r);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Brain learning trigger — reflection analysis + self-goal creation
  app.post('/api/brain/learn', async (req, res) => {
    try {
      const r = await brain.considerNewGoals();
      res.json({ ok: true, ...r });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

}   // ← registerRoutes ends here

// ============ BOOTSTRAP ============
function startWorker() {
  const app = createApp();
  registerRoutes(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  const server = http.createServer(app);

  server.keepAliveTimeout = 65000;
  server.headersTimeout  = 66000;
  server.requestTimeout  = 30000;

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`Received ${signal}, shutting down...`);

    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, CONFIG.shutdownTimeout).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', { message: err.message, stack: err.stack });
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', { reason: String(reason) });
  });

  server.listen(CONFIG.port, () => {
    logger.info(`🧠 AI Brain running on port ${CONFIG.port} [pid ${process.pid}] [${CONFIG.env}]`);
  });

  return server;
}

if (CONFIG.isProd && CONFIG.workers !== 1) {
  const numWorkers = CONFIG.workers || Math.min(os.cpus().length, 4);

  if (cluster.isPrimary) {
    logger.info(`Primary ${process.pid} starting ${numWorkers} workers`);
    for (let i = 0; i < numWorkers; i++) cluster.fork();

    cluster.on('exit', (worker, code, signal) => {
      logger.warn(`Worker ${worker.process.pid} died (${signal || code}), restarting`);
      cluster.fork();
    });
  } else {
    startWorker();
  }
} else {
  startWorker();
}

module.exports = { createApp, startWorker };
