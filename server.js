const taskAgent = require('./agents/taskAgent');
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cluster = require('cluster');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const projectScanner = require('./core/projectScanner');
const selfAnalyzer = require('./core/selfAnalyzer');
const memoryManager = require('./core/memoryManager');

// ============ CONFIG ============
const CONFIG = {
  port: parseInt(process.env.PORT, 10) || 3000,
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  workers: parseInt(process.env.WORKERS, 10) || 0, // 0 = auto
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
      level,
      msg,
      pid: process.pid,
      ...(meta && { meta }),
    };
    const out = CONFIG.isProd
      ? JSON.stringify(entry)
      : `[${entry.time}] ${level.toUpperCase().padEnd(5)} ${msg}` +
        (meta ? ` ${JSON.stringify(meta)}` : '');
    (level === 'error' ? process.stderr : process.stdout).write(out + '\n');
  },
  error(m, meta) { this._write('error', m, meta); },
  warn(m, meta) { this._write('warn', m, meta); },
  info(m, meta) { this._write('info', m, meta); },
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
        rssMB: +(mem.rss / 1024 / 1024).toFixed(2),
        heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(2),
        heapTotalMB: +(mem.heapTotal / 1024 / 1024).toFixed(2),
        externalMB: +(mem.external / 1024 / 1024).toFixed(2),
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
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`]
    .filter(Boolean)
    .join(' ');
}

// ============ REQUEST ID ============
function requestIdMiddleware(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomBytes(8).toString('hex');
  res.set('X-Request-Id', req.id);
  next();
}

// ============ API KEY AUTH ============
function apiKeyAuth(req, res, next) {
  if (!CONFIG.apiKey) return next(); // disabled if no key set

  const provided =
    req.headers['x-api-key'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (!provided || provided !== CONFIG.apiKey) {
    logger.warn('Auth failed', { ip: req.ip, path: req.path });
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// ============ ERROR HANDLER ============
function errorHandler(err, req, res, _next) {
  metrics.errors++;
  logger.error('Request failed', {
    id: req.id,
    path: req.path,
    method: req.method,
    message: err.message,
  });

  res.status(err.status || 500).json({
    ok: false,
    error: err.message || 'Internal Server Error',
    requestId: req.id,
    ...(CONFIG.isProd ? {} : { stack: err.stack }),
  });
}

// ============ 404 HANDLER ============
function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    error: 'Not Found',
    path: req.path,
    requestId: req.id,
  });
}

// ============ ASYNC WRAPPER ============
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ============ CREATE APP ============
function createApp() {
  const app = express();

  // Trust proxy (for correct IP behind nginx/heroku)
  if (CONFIG.trustProxy) app.set('trust proxy', 1);

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: false, // API server — disable CSP
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  // CORS
  app.use(cors({
    origin: CONFIG.corsOrigin === '*' ? true : CONFIG.corsOrigin.split(','),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-Id'],
  }));

  // Compression
  app.use(compression());

  // Body parser
  app.use(express.json({ limit: CONFIG.bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: CONFIG.bodyLimit }));

  // Request ID
  app.use(requestIdMiddleware);

  // HTTP logging
  app.use(morgan(CONFIG.isProd ? 'combined' : 'dev', {
    stream: { write: (msg) => logger.info(msg.trim()) },
  }));

  // Metrics
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      metrics.record(res, req.route?.path || req.path, Date.now() - start);
    });
    next();
  });

  // Global rate limit
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
  // ---------- HEALTH ----------
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
      memory: {
        heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(2),
      },
      time: new Date().toISOString(),
      requestId: req.id,
    });
  };

  // ROUTE FIXED: Changed from /task to /api/swarm to match your frontend requests
  app.post('/api/swarm', async (req, res) => {
    try {
      const { command } = req.body;
      const result = await taskAgent.execute(
        command || ''
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err.message
      });
    }
  });

  app.get('/health', healthHandler);
  app.get('/api/v1/health', healthHandler);

  // ---------- LIVENESS / READINESS ----------
  app.get('/live', (req, res) => res.json({ ok: true }));
  app.get('/ready', (req, res) => {
    try {
      memoryManager.loadMemory();
      res.json({ ok: true, ready: true });
    } catch (err) {
      res.status(503).json({ ok: false, ready: false, error: err.message });
    }
  });

  // ---------- ANALYZE (rate limited) ----------
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

      if (save) {
        await memoryManager.addProjectScan(report);
      }

      metrics.scans++;
      metrics.lastScanAt = new Date().toISOString();

      logger.info('Scan complete', {
        id: req.id,
        score: report.score,
        files: report.overview?.totalFiles,
        durationMs: Date.now() - t0,
      });

      res.json({
        ok: true,
        requestId: req.id,
        durationMs: Date.now() - t0,
        report,
      });
    })
  );

  // ---------- MEMORY ----------
  app.get(
    '/api/v1/memory',
    apiKeyAuth,
    asyncHandler(async (req, res) => {
      const mem = await memoryManager.loadMemory();
      res.json({ ok: true, memory: mem });
    })
  );

  app.get(
    '/api/v1/memory/stats',
    apiKeyAuth,
    asyncHandler(async (req, res) => {
      res.json({ ok: true, ...memoryManager.getMemoryStats() });
    })
  );

  app.get(
    '/api/v1/memory/trend',
    apiKeyAuth,
    asyncHandler(async (req, res) => {
      const window = parseInt(req.query.window, 10) || 10;
      res.json({ ok: true, ...memoryManager.getScoreTrend(window) });
    })
  );

  app.get(
    '/api/v1/memory/skills',
    apiKeyAuth,
    asyncHandler(async (req, res) => {
      const skills = req.query.category
        ? memoryManager.getSkillsByCategory(req.query.category)
        : (await memoryManager.loadMemory()).learnedSkills;
      res.json({ ok: true, count: skills.length, skills });
    })
  );

  app.post(
    '/api/v1/memory/skill',
    apiKeyAuth,
    asyncHandler(async (req, res) => {
      if (!req.body || !req.body.name) {
        return res.status(400).json({ ok: false, error: 'name required' });
      }
      const skills = await memoryManager.addSkill(req.body);
      res.json({ ok: true, skills });
    })
  );

  app.get(
    '/api/v1/memory/export',
    apiKeyAuth,
    asyncHandler(async (req, res) => {
      const format = req.query.format || 'json';
      const data = memoryManager.exportMemory(format);
      res.set('Content-Type', format === 'csv' ? 'text/csv' : 'application/json');
      res.set('Content-Disposition', `attachment; filename="memory.${format}"`);
      res.send(data);
    })
  );

  // ---------- SYSTEM ----------
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
}

// ============ BOOTSTRAP ============
function startWorker() {
  const app = createApp();
  registerRoutes(app);

  // 404 + error (always last)
  app.use(notFoundHandler);
  app.use(errorHandler);

  const server = http.createServer(app);

  // -------- SOCKET TIMEOUTS --------
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 30000;

  // -------- GRACEFUL SHUTDOWN --------
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
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', { message: err.message, stack: err.stack });
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', { reason: String(reason) });
  });

  // -------- START --------
  server.listen(CONFIG.port, () => {
    logger.info(
      `🧠 AI Brain running on port ${CONFIG.port} [pid ${process.pid}] [${CONFIG.env}]`
    );
  });

  return server;
}

// ============ CLUSTER MODE ============
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
