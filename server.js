// server.js — Nexus Forge Engine (Brain-Powered) — FINAL V5
'use strict';

require('dotenv').config();

/* ============ CORE IMPORTS ============ */
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

/* ============ APP MODULES ============ */
const taskAgent      = require('./agents/taskAgent');
const memoryManager  = require('./core/memoryManager');
const selfAnalyzer   = require('./core/selfAnalyzer');

/* ============ 🧠 BRAIN MODULES ============ */
const brain         = require('./core/brain/brainCore');
const goals         = require('./core/brain/goalEngine');
const codeAdvisor   = require('./core/brain/codeAdvisor');
const knowledge     = require('./core/brain/knowledgeGraph');
const strategies    = require('./core/brain/strategyEngine');
const reflection    = require('./core/brain/reflectionEngine');

/* ============ CONFIG ============ */
const CONFIG = {
  port: parseInt(process.env.PORT, 10) || 3000,
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  workers: parseInt(process.env.WORKERS, 10) || 0,
  apiVersion: 'v1',
  bodyLimit: process.env.BODY_LIMIT || '1mb', // 🔥 Yahan limit 1mb kar di gayi hai
  corsOrigin: process.env.CORS_ORIGIN || '*',
  apiKey: process.env.API_KEY || null,
  trustProxy: process.env.TRUST_PROXY === 'true',
  shutdownTimeout: 10_000,
  requestTimeoutMs: 60_000,     // hard cap per request
  dedupeWindowMs: 5_000,        // identical request reuse window
  workerBackoffMax: 30_000,
  rateLimit: {
    windowMs: 60 * 1000,
    max: 100,
    analyze: 10,
    swarm: 30,
    perUserMax: 60,
  },
};

/* ============ LOGGER ============ */
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

/* ============ METRICS ============ */
const metrics = {
  startedAt: Date.now(),
  requests: { total: 0, byStatus: {}, byRoute: {} },
  errors: 0,
  scans: 0,
  lastScanAt: null,
  inFlight: 0,
  dedupHits: 0,

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
      inFlight: this.inFlight,
      dedupHits: this.dedupHits,
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

  prometheus() {
    const snap = this.snapshot();
    const lines = [
      `# HELP nexus_uptime_seconds Uptime in seconds`,
      `# TYPE nexus_uptime_seconds counter`,
      `nexus_uptime_seconds ${snap.uptimeSec}`,
      `# HELP nexus_requests_total Total HTTP requests`,
      `# TYPE nexus_requests_total counter`,
      `nexus_requests_total ${snap.requests.total}`,
      `# HELP nexus_errors_total Total 5xx errors`,
      `# TYPE nexus_errors_total counter`,
      `nexus_errors_total ${snap.errors}`,
      `# HELP nexus_in_flight Current in-flight requests`,
      `# TYPE nexus_in_flight gauge`,
      `nexus_in_flight ${snap.inFlight}`,
      `# HELP nexus_memory_heap_bytes Heap used`,
      `# TYPE nexus_memory_heap_bytes gauge`,
      `nexus_memory_heap_bytes ${Math.round(snap.memory.heapUsedMB * 1024 * 1024)}`,
      `# HELP nexus_dedup_hits_total Deduplicated requests`,
      `# TYPE nexus_dedup_hits_total counter`,
      `nexus_dedup_hits_total ${snap.dedupHits}`,
    ];
    for (const [route, data] of Object.entries(snap.requests.byRoute)) {
      const safeRoute = route.replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`nexus_route_requests_total{route="${safeRoute}"} ${data.count}`);
      lines.push(`nexus_route_errors_total{route="${safeRoute}"} ${data.errors}`);
    }
    return lines.join('\n') + '\n';
  },
};

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ');
}

/* ============ RESPONSE DEDUPE CACHE ============ */
const dedupeCache = new Map(); // key -> { expires, payload }
function dedupeKey(body, userId) {
  return crypto
    .createHash('sha256')
    .update(`${userId || 'anon'}:${JSON.stringify(body)}`)
    .digest('hex');
}
function dedupeGet(key) {
  const e = dedupeCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { dedupeCache.delete(key); return null; }
  return e.payload;
}
function dedupeSet(key, payload) {
  dedupeCache.set(key, { expires: Date.now() + CONFIG.dedupeWindowMs, payload });
  if (dedupeCache.size > 500) {
    dedupeCache.delete(dedupeCache.keys().next().value);
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of dedupeCache) if (v.expires < now) dedupeCache.delete(k);
}, 30_000).unref();

/* ============ REQUEST ID + AUDIT ============ */
function requestIdMiddleware(req, res, next) {
  req.id = String(req.headers['x-request-id'] || crypto.randomBytes(8).toString('hex')).slice(0, 64);
  req.startTime = Date.now();
  req.correlationId = req.id; // brain will use this
  res.set('X-Request-Id', req.id);
  metrics.inFlight++;
  res.on('finish', () => { metrics.inFlight--; });

  // Structured audit — one line per request, safe fields only
  res.on('finish', () => {
    logger.debug('audit', {
      id: req.id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - req.startTime,
      ip: req.ip,
      ua: (req.headers['user-agent'] || '').slice(0, 80),
    });
  });
  next();
}

/* ============ REQUEST TIMEOUT ============ */
function timeoutMiddleware(req, res, next) {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(503).json({
        ok: false, error: 'Request timed out', errorCode: 'E_TIMEOUT', requestId: req.id,
      });
    }
  }, CONFIG.requestTimeoutMs);
  res.on('finish', () => clearTimeout(timer));
  res.on('close',  () => clearTimeout(timer));
  next();
}

/* ============ API KEY AUTH ============ */
function apiKeyAuth(req, res, next) {
  if (!CONFIG.apiKey) return next();
  const provided =
    req.headers['x-api-key'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!provided || provided !== CONFIG.apiKey) {
    logger.warn('Auth failed', { ip: req.ip, path: req.path, id: req.id });
    return res.status(401).json({ ok: false, error: 'Unauthorized', errorCode: 'E_AUTH', requestId: req.id });
  }
  next();
}

/* ============ INPUT VALIDATION ============ */
function requireJsonString(field, maxLen = 12_000) {
  return (req, res, next) => {
    const v = req.body && req.body[field];
    if (typeof v !== 'string') {
      return res.status(400).json({
        ok: false, error: `${field} must be a string`,
        errorCode: 'E_VALIDATION', requestId: req.id,
      });
    }
    const clean = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    if (!clean) {
      return res.status(400).json({
        ok: false, error: `${field} cannot be empty`,
        errorCode: 'E_VALIDATION', requestId: req.id,
      });
    }
    if (clean.length > maxLen) {
      return res.status(413).json({
        ok: false, error: `${field} exceeds ${maxLen} characters`,
        errorCode: 'E_TOO_LARGE', requestId: req.id,
      });
    }
    req.body[field] = clean;
    next();
  };
}

/* ============ ERROR HANDLERS ============ */
function bodyParseErrorHandler(err, req, res, next) {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      ok: false, error: 'Invalid JSON body',
      errorCode: 'E_JSON_PARSE', requestId: req.id,
    });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      ok: false, error: 'Payload too large',
      errorCode: 'E_TOO_LARGE', requestId: req.id,
    });
  }
  next(err);
}

function errorHandler(err, req, res, _next) {
  metrics.errors++;
  const status = err.status || 500;
  logger.error('Request failed', {
    id: req.id, path: req.path, method: req.method,
    status, message: err.message, code: err.code || err.errorCode,
  });
  const payload = {
    ok: false,
    error: status === 500 && CONFIG.isProd ? 'Internal Server Error' : (err.message || 'Server error'),
    errorCode: err.errorCode || err.code || (status === 500 ? 'E_INTERNAL' : 'E_UNKNOWN'),
    requestId: req.id,
  };
  if (!CONFIG.isProd) payload.stack = err.stack;
  res.status(status).json(payload);
}

function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false, error: 'Not Found', errorCode: 'E_NOT_FOUND',
    path: req.path, requestId: req.id,
  });
}

/* ============ ASYNC WRAPPER ============ */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/* ============ APP ============ */
function createApp() {
  const app = express();

  if (CONFIG.trustProxy) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: CONFIG.isProd ? undefined : false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  // CORS: wildcard + credentials is invalid → handle properly
  const corsOrigin = CONFIG.corsOrigin === '*'
    ? true
    : CONFIG.corsOrigin.split(',').map(s => s.trim()).filter(Boolean);
  const allowCredentials = CONFIG.corsOrigin !== '*';

  app.use(cors({
    origin: corsOrigin,
    credentials: allowCredentials,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  }));

  app.use(compression({ threshold: '1kb' }));
  app.use(express.json({ limit: CONFIG.bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: CONFIG.bodyLimit }));
  app.use(bodyParseErrorHandler);

  app.use(requestIdMiddleware);
  app.use(timeoutMiddleware);

  // morgan: skip health checks in logs (noise)
  app.use(morgan(CONFIG.isProd ? 'combined' : 'dev', {
    skip: (req) => ['/health', '/live', '/ready', '/metrics'].includes(req.path),
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
    message: { ok: false, error: 'Too many requests, slow down', errorCode: 'E_RATE_LIMIT' },
  }));

  return app;
}

/* ============ ROUTES ============ */
function registerRoutes(app) {

  /* ---------- HEALTH (real dependency probes) ---------- */
  const healthHandler = (req, res) => {
    const mem = process.memoryUsage();
    let brainHealth = { ok: false };
    try { brainHealth = brain.healthCheck?.() || { ok: true }; } catch (e) { brainHealth = { ok: false, error: e.message }; }

    res.json({
      ok: true,
      status: 'online',
      brain: brainHealth.ok ? 'active' : 'degraded',
      brainHealth,
      version: require('./package.json').version,
      env: CONFIG.env,
      pid: process.pid,
      worker: cluster.isWorker ? cluster.worker.id : 'primary',
      uptime: formatUptime(Math.floor((Date.now() - metrics.startedAt) / 1000)),
      memory: { heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(2) },
      time: new Date().toISOString(),
      requestId: req.id,
    });
  };

  app.get('/health', healthHandler);
  app.get('/api/v1/health', healthHandler);

  app.get('/live', (req, res) => res.json({ ok: true, ts: Date.now() }));

  app.get('/ready', asyncHandler(async (req, res) => {
    const checks = { memory: false, brain: false };
    let err = null;
    try { memoryManager.loadMemory(); checks.memory = true; } catch (e) { err = e.message; }
    try { checks.brain = !!brain.healthCheck?.().ok; } catch (e) { err = err || e.message; }
    const ready = checks.memory && checks.brain;
    res.status(ready ? 200 : 503).json({ ok: ready, ready, checks, error: err });
  }));

  /* ---------- PROMETHEUS METRICS ---------- */
  app.get('/metrics', (req, res) => {
    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(metrics.prometheus());
  });

  /* ============================================================
   * 🔥 MAIN SWARM ROUTE — BRAIN-POWERED (with dedupe)
   * ============================================================ */
  const swarmLimiter = rateLimit({
    windowMs: CONFIG.rateLimit.windowMs,
    max: CONFIG.rateLimit.swarm,
    message: { ok: false, error: 'Swarm rate limit exceeded', errorCode: 'E_RATE_LIMIT' },
  });

  app.post(
    '/api/swarm',
    swarmLimiter,
    requireJsonString('command', 12_000),
    asyncHandler(async (req, res) => {
      const { command, userId = 'ceo', saveMemory = true, strategy } = req.body;

      // Dedupe identical recent requests
      const key = dedupeKey({ command, userId, strategy }, userId);
      const cached = dedupeGet(key);
      if (cached) {
        metrics.dedupHits++;
        return res.json({ ...cached, deduped: true });
      }

      const result = await brain.think(command, {
        userId,
        saveMemory,
        strategy,          // optional forced strategy
        correlationId: req.correlationId,
      });

      const payload = {
        status: result.ok ? 'success' : 'partial',
        managerReply: result.reply || 'Boss, main request process nahi kar paya.',
        strategy: result.strategy,
        latencyMs: result.latencyMs,
        recalledMemories: result.recalledCount,
        memorySaved: result.memorySaved,
        correlationId: result.correlationId,
        requestId: req.id,
        warnings: result.warnings,
      };

      dedupeSet(key, payload);
      res.json(payload);
    })
  );

  /* ---------- SSE STREAMING VARIANT ---------- */
  app.post(
    '/api/swarm/stream',
    swarmLimiter,
    requireJsonString('command', 12_000),
    asyncHandler(async (req, res) => {
      const { command, userId = 'ceo' } = req.body;
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();

      const send = (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      send('start', { requestId: req.id, correlationId: req.correlationId });
      const keep = setInterval(() => res.write(': ping\n\n'), 15_000);

      try {
        const result = await brain.think(command, {
          userId,
          correlationId: req.correlationId,
        });
        send('result', {
          ok: result.ok,
          reply: result.reply,
          strategy: result.strategy,
          latencyMs: result.latencyMs,
          correlationId: result.correlationId,
        });
        send('done', { ts: Date.now() });
      } catch (err) {
        send('error', { message: err.message, requestId: req.id });
      } finally {
        clearInterval(keep);
        res.end();
      }
    })
  );

  /* ---------- USER FEEDBACK (learning signal) ---------- */
  app.post('/api/brain/feedback', express.json(), (req, res) => {
    try {
      const { correlationId, rating } = req.body || {};
      if (!correlationId || rating === undefined) {
        return res.status(400).json({ ok: false, error: 'correlationId and rating required' });
      }
      if (typeof brain.feedback !== 'function') {
        return res.status(501).json({ ok: false, error: 'Feedback not supported by brain' });
      }
      const r = brain.feedback(correlationId, rating);
      res.json(r);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /* ---------- ANALYZE ---------- */
  const analyzeLimiter = rateLimit({
    windowMs: CONFIG.rateLimit.windowMs,
    max: CONFIG.rateLimit.analyze,
    message: { ok: false, error: 'Analyze rate limit exceeded', errorCode: 'E_RATE_LIMIT' },
  });

  app.get(
    ['/analyze', '/api/v1/analyze'],
    analyzeLimiter,
    apiKeyAuth,
    asyncHandler(async (req, res) => {
      const t0 = Date.now();
      const deep = req.query.deep !== 'false';
      const save = req.query.save !== 'false';

      // Yield to event loop before heavy sync work
      await new Promise(r => setImmediate(r));
      const report = selfAnalyzer.analyze({ deep });
      if (save) await memoryManager.addProjectScan(report);

      metrics.scans++;
      metrics.lastScanAt = new Date().toISOString();

      logger.info('Scan complete', {
        id: req.id, score: report.score,
        files: report.overview?.totalFiles, durationMs: Date.now() - t0,
      });

      res.json({ ok: true, requestId: req.id, durationMs: Date.now() - t0, report });
    })
  );

  /* ---------- MEMORY ENDPOINTS ---------- */
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
      return res.status(400).json({ ok: false, error: 'name required', errorCode: 'E_VALIDATION' });
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

  /* ---------- METRICS & SYSTEM ---------- */
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

  /* ============================================================
   * 🧠 BRAIN ENDPOINTS
   * ============================================================ */
  app.get('/api/brain', asyncHandler(async (req, res) => {
    const snap = brain.snapshot();
    let explain = 'Brain online hai Boss.';
    try { explain = await brain.explainSelf(); } catch (_) { /* ignore */ }
    res.json({ ok: true, snapshot: snap, explanation: explain });
  }));

  app.get('/api/brain/health', (req, res) => {
    try { res.json({ ok: true, ...(brain.healthCheck?.() || {}) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get('/api/brain/thoughts', (req, res) => {
    try {
      const limit = Math.min(200, parseInt(req.query.limit, 10) || 20);
      const snap = brain.snapshot();
      res.json({ ok: true, thoughts: snap.thoughts.slice(-limit) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get('/api/brain/goals', (req, res) => {
    try { res.json({ ok: true, ...goals.stats(), list: goals.prioritized(20) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post('/api/brain/goals', (req, res) => {
    try {
      const { title, description, priority, tags } = req.body || {};
      if (!title) return res.status(400).json({ ok: false, error: 'title required', errorCode: 'E_VALIDATION' });
      res.json(goals.addGoal({ title, description, priority, tags, source: 'api' }));
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post('/api/brain/goals/:id/progress', (req, res) => {
    try {
      const { progress, note } = req.body || {};
      res.json(goals.updateProgress(req.params.id, progress, note));
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post('/api/brain/goals/:id/complete', (req, res) => {
    try {
      const { outcome } = req.body || {};
      res.json(goals.complete(req.params.id, outcome || 'success'));
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post('/api/brain/goals/:id/abandon', (req, res) => {
    try {
      const { reason } = req.body || {};
      res.json(goals.abandon(req.params.id, reason || ''));
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get('/api/brain/knowledge', (req, res) => {
    try {
      if (req.query.q) {
        const hits = knowledge.search(req.query.q, parseInt(req.query.limit, 10) || 5);
        return res.json({ ok: true, query: req.query.q, hits });
      }
      res.json({ ok: true, ...knowledge.stats() });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post('/api/brain/knowledge', (req, res) => {
    try {
      const { type, content, tags, weight } = req.body || {};
      if (!content) return res.status(400).json({ ok: false, error: 'content required', errorCode: 'E_VALIDATION' });
      res.json(knowledge.addNode({ type, content, tags, weight }));
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get('/api/brain/strategies', (req, res) => {
    try {
      res.json({
        ok: true,
        ...strategies.stats(),
        ranking: strategies.ranking(req.query.category || null),
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get('/api/brain/reflections', (req, res) => {
    try {
      res.json({ ok: true, ...reflection.summary(parseInt(req.query.last, 10) || 50) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get('/api/brain/reflections/similar', (req, res) => {
    try {
      res.json({ ok: true, similar: reflection.findSimilar(req.query.q || '', parseInt(req.query.limit, 10) || 3) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get('/api/brain/code-suggestions', (req, res) => {
    try {
      res.json({ ok: true, ...codeAdvisor.stats(), list: codeAdvisor.list(req.query.status || 'pending') });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post('/api/brain/code-suggestions', asyncHandler(async (req, res) => {
    const { file, concern } = req.body || {};
    if (!file) return res.status(400).json({ ok: false, error: 'file required', errorCode: 'E_VALIDATION' });
    const r = await codeAdvisor.suggestFor(file, concern || '');
    res.json(r);
  }));

  app.post('/api/brain/code-suggestions/:id/approve', (req, res) => {
    try { res.json(codeAdvisor.approve(req.params.id, (req.body && req.body.note) || '')); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post('/api/brain/code-suggestions/:id/reject', (req, res) => {
    try { res.json(codeAdvisor.reject(req.params.id, (req.body && req.body.reason) || '')); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post('/api/brain/learn', asyncHandler(async (req, res) => {
    const r = await brain.considerNewGoals();
    res.json({ ok: true, ...r });
  }));
}

/* ============ BOOTSTRAP ============ */
function startWorker() {
  const app = createApp();
  registerRoutes(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  const server = http.createServer(app);

  server.keepAliveTimeout = 65_000;
  server.headersTimeout  = 66_000;
  server.requestTimeout  = CONFIG.requestTimeoutMs + 5_000;

  // Track open sockets for hard shutdown
  const sockets = new Set();
  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`Received ${signal}, shutting down...`);

    // Ask brain to flush state
    try { brain.shutdown?.(); } catch (e) { logger.warn('brain.shutdown failed', { err: e.message }); }

    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });

    // Force close lingering sockets after timeout
    setTimeout(() => {
      logger.error('Forced shutdown — closing sockets');
      for (const s of sockets) s.destroy();
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

/* ============ CLUSTER ============ */
if (CONFIG.isProd && CONFIG.workers !== 1) {
  const numWorkers = CONFIG.workers || Math.min(os.cpus().length, 4);

  if (cluster.isPrimary) {
    logger.info(`Primary ${process.pid} starting ${numWorkers} workers`);
    for (let i = 0; i < numWorkers; i++) cluster.fork();

    const restartTimestamps = [];

    cluster.on('exit', (worker, code, signal) => {
      logger.warn(`Worker ${worker.process.pid} died (${signal || code})`);

      // Crash-loop protection: if >5 restarts in 60s, back off
      const now = Date.now();
      restartTimestamps.push(now);
      while (restartTimestamps.length && restartTimestamps[0] < now - 60_000) restartTimestamps.shift();

      const delay = Math.min(CONFIG.workerBackoffMax, 500 * restartTimestamps.length ** 2);
      setTimeout(() => {
        if (restartTimestamps.length > 5) {
          logger.error('Too many worker crashes — delaying restart', { delayMs: delay });
        }
        cluster.fork();
      }, delay).unref();
    });

    // Periodic rebalance check
    setInterval(() => {
      const alive = Object.keys(cluster.workers || {}).length;
      if (alive < numWorkers) {
        logger.warn(`Only ${alive}/${numWorkers} workers alive — rebalancing`);
        for (let i = alive; i < numWorkers; i++) cluster.fork();
      }
    }, 30_000).unref();

  } else {
    startWorker();
  }
} else {
  startWorker();
}

module.exports = { createApp, startWorker };
