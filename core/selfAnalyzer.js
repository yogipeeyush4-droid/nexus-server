const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const projectScanner = require('./projectScanner');

// ============ SKILL REGISTRY ============
// Central registry — naya skill add karna easy
const SKILL_REGISTRY = {
  pdfReader: {
    category: 'document',
    patterns: [/pdf/i, /pdfreader/i, /pdf-parse/i, /pdfkit/i, /pdfjs/i],
    packages: ['pdf-parse', 'pdfkit', 'pdfjs-dist', 'pdf-lib'],
    description: 'PDF reading/parsing capability',
    priority: 'medium',
  },
  imageAnalyzer: {
    category: 'vision',
    patterns: [/imageanaly/i, /image-analyz/i, /vision/i, /ocr/i, /tesseract/i],
    packages: ['sharp', 'jimp', 'tesseract.js', 'image-size'],
    description: 'Image analysis & OCR',
    priority: 'medium',
  },
  browserAgent: {
    category: 'automation',
    patterns: [/browser/i, /puppeteer/i, /playwright/i, /selenium/i],
    packages: ['puppeteer', 'playwright', 'selenium-webdriver'],
    description: 'Browser automation',
    priority: 'high',
  },
  speechToText: {
    category: 'audio',
    patterns: [/speech/i, /whisper/i, /stt/i, /transcri/i],
    packages: ['openai', '@google-cloud/speech'],
    description: 'Speech recognition',
    priority: 'low',
  },
  textToSpeech: {
    category: 'audio',
    patterns: [/tts/i, /texttospeech/i, /speak/i],
    packages: ['@google-cloud/text-to-speech'],
    description: 'Text-to-speech',
    priority: 'low',
  },
  database: {
    category: 'data',
    patterns: [/database/i, /db\.js/i, /models?\//i, /schema/i],
    packages: ['mongoose', 'sequelize', 'prisma', 'pg', 'mysql2', 'sqlite3'],
    description: 'Database layer',
    priority: 'high',
  },
  authentication: {
    category: 'security',
    patterns: [/auth/i, /login/i, /jwt/i, /passport/i],
    packages: ['passport', 'jsonwebtoken', 'bcrypt', 'express-session'],
    description: 'Auth system',
    priority: 'high',
  },
  apiClient: {
    category: 'network',
    patterns: [/axios/i, /fetch/i, /request/i, /api[-_]?client/i],
    packages: ['axios', 'node-fetch', 'got', 'undici'],
    description: 'HTTP client',
    priority: 'medium',
  },
  websocket: {
    category: 'network',
    patterns: [/socket/i, /websocket/i, /ws\.js/i],
    packages: ['socket.io', 'ws'],
    description: 'Real-time communication',
    priority: 'medium',
  },
  caching: {
    category: 'performance',
    patterns: [/cache/i, /redis/i, /memcach/i],
    packages: ['redis', 'node-cache', 'lru-cache', 'ioredis'],
    description: 'Caching layer',
    priority: 'medium',
  },
  logging: {
    category: 'observability',
    patterns: [/logger/i, /winston/i, /pino/i, /log\.js/i],
    packages: ['winston', 'pino', 'morgan', 'bunyan'],
    description: 'Logging system',
    priority: 'low',
  },
  testing: {
    category: 'quality',
    patterns: [/\.test\./i, /\.spec\./i, /__tests__/i],
    packages: ['jest', 'mocha', 'vitest', 'chai', 'supertest'],
    description: 'Test suite',
    priority: 'high',
  },
  linter: {
    category: 'quality',
    patterns: [/eslint/i, /prettier/i, /tslint/i],
    packages: ['eslint', 'prettier'],
    description: 'Code linting',
    priority: 'low',
  },
  docker: {
    category: 'devops',
    patterns: [/dockerfile/i, /docker-compose/i],
    packages: [],
    description: 'Containerization',
    priority: 'high',
  },
  ci: {
    category: 'devops',
    patterns: [/\.github/i, /\.gitlab-ci/i, /jenkinsfile/i, /travis/i],
    packages: [],
    description: 'CI/CD pipeline',
    priority: 'high',
  },
  envConfig: {
    category: 'config',
    patterns: [/\.env/i, /dotenv/i, /config\.js/i],
    packages: ['dotenv', 'convict', 'config'],
    description: 'Environment configuration',
    priority: 'high',
  },
  cli: {
    category: 'interface',
    patterns: [/cli\.js/i, /bin\//i, /commander/i, /yargs/i],
    packages: ['commander', 'yargs', 'inquirer', 'ora'],
    description: 'CLI interface',
    priority: 'medium',
  },
  scheduler: {
    category: 'automation',
    patterns: [/cron/i, /schedul/i, /job/i, /queue/i],
    packages: ['node-cron', 'bull', 'agenda', 'bullmq'],
    description: 'Task scheduling',
    priority: 'medium',
  },
  email: {
    category: 'communication',
    patterns: [/mail/i, /email/i, /smtp/i],
    packages: ['nodemailer', 'sendgrid', '@sendgrid/mail'],
    description: 'Email sending',
    priority: 'low',
  },
  payment: {
    category: 'business',
    patterns: [/payment/i, /stripe/i, /razorpay/i, /paypal/i],
    packages: ['stripe', 'razorpay', '@paypal/checkout-server-sdk'],
    description: 'Payment gateway',
    priority: 'low',
  },
  fileUpload: {
    category: 'storage',
    patterns: [/upload/i, /multer/i, /multipart/i],
    packages: ['multer', 'formidable', 'busboy'],
    description: 'File upload handling',
    priority: 'medium',
  },
  search: {
    category: 'data',
    patterns: [/search/i, /elastic/i, /algolia/i],
    packages: ['elasticsearch', 'algoliasearch', 'lunr', 'fuse.js'],
    description: 'Search engine',
    priority: 'low',
  },
  ai: {
    category: 'intelligence',
    patterns: [/openai/i, /anthropic/i, /llm/i, /gpt/i, /claude/i, /gemini/i],
    packages: ['openai', '@anthropic-ai/sdk', '@google/generative-ai', 'langchain'],
    description: 'AI/LLM integration',
    priority: 'high',
  },
  vectorDb: {
    category: 'intelligence',
    patterns: [/pinecone/i, /weaviate/i, /chroma/i, /qdrant/i, /vector/i],
    packages: ['@pinecone-database/pinecone', 'weaviate-ts-client', 'chromadb'],
    description: 'Vector database',
    priority: 'low',
  },
};

// ============ SECURITY PATTERNS ============
const SECURITY_RISKS = [
  {
    id: 'hardcoded-secret',
    regex: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    severity: 'critical',
    message: 'Hardcoded secret detected',
  },
  {
    id: 'eval-usage',
    regex: /\beval\s*\(/g,
    severity: 'high',
    message: 'eval() usage — code injection risk',
  },
  {
    id: 'child-process',
    regex: /child_process|execSync|exec\(/g,
    severity: 'medium',
    message: 'Command execution — validate inputs',
  },
  {
    id: 'sql-injection',
    regex: /(query|execute)\s*\(\s*[`'"].*\$\{/g,
    severity: 'high',
    message: 'Possible SQL injection',
  },
  {
    id: 'http-not-https',
    regex: /['"]http:\/\/(?!localhost|127\.0\.0\.1)[^'"]+['"]/g,
    severity: 'medium',
    message: 'Insecure HTTP URL (use HTTPS)',
  },
  {
    id: 'cors-wildcard',
    regex: /origin\s*:\s*['"]\*['"]/g,
    severity: 'medium',
    message: 'CORS wildcard — restrict origins',
  },
];

// ============ HELPERS ============
function safeRead(filePath, maxBytes = 512 * 1024) {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > maxBytes) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function detectSkills(files, packageDeps) {
  const detected = {};
  const fileNames = files.map((f) => f.name.toLowerCase());
  const filePaths = files.map((f) => f.path.toLowerCase());
  const allNames = fileNames.join(' ') + ' ' + filePaths.join(' ');
  const depsList = Object.keys(packageDeps).map((d) => d.toLowerCase());

  for (const [skillName, skill] of Object.entries(SKILL_REGISTRY)) {
    const matchedFiles = [];
    const matchedPackages = [];

    // Pattern match in filenames
    for (let i = 0; i < files.length; i++) {
      if (skill.patterns.some((p) => p.test(fileNames[i]) || p.test(filePaths[i]))) {
        matchedFiles.push(files[i].name);
      }
    }

    // Package match
    for (const pkg of skill.packages) {
      if (depsList.includes(pkg.toLowerCase())) {
        matchedPackages.push(pkg);
      }
    }

    if (matchedFiles.length > 0 || matchedPackages.length > 0) {
      detected[skillName] = {
        category: skill.category,
        description: skill.description,
        confidence: matchedPackages.length > 0 ? 'high' : 'medium',
        matchedFiles: [...new Set(matchedFiles)].slice(0, 10),
        matchedPackages,
      };
    }
  }

  return detected;
}

function findMissingSkills(detected, requiredSkills) {
  const missing = [];
  for (const skill of requiredSkills) {
    if (!detected[skill]) {
      const reg = SKILL_REGISTRY[skill];
      missing.push({
        skill,
        priority: reg?.priority || 'medium',
        description: reg?.description || `Skill "${skill}" not detected`,
        suggestion: reg?.packages?.length
          ? `Install: npm install ${reg.packages[0]}`
          : 'Create dedicated module/file for this feature',
      });
    }
  }
  return missing.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.priority] - order[b.priority];
  });
}

function readPackageJson(rootDir) {
  const pkgPath = path.join(rootDir, 'package.json');
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getDependencies(pkg) {
  if (!pkg) return {};
  return {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };
}

// ============ SECURITY AUDIT ============
function securityAudit(files, rootDir) {
  const findings = [];
  const scanExts = new Set(['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '.json', '.env']);

  // Check .env file existence
  const envFile = path.join(rootDir, '.env');
  const gitignore = path.join(rootDir, '.gitignore');
  const hasEnv = fs.existsSync(envFile);
  const hasGitignore = fs.existsSync(gitignore);

  if (hasEnv) {
    const gi = hasGitignore ? safeRead(gitignore) || '' : '';
    if (!gi.includes('.env')) {
      findings.push({
        id: 'env-not-ignored',
        severity: 'critical',
        message: '.env file exists but not in .gitignore',
        file: '.gitignore',
      });
    }
  }

  // Scan files
  for (const file of files) {
    if (!scanExts.has(file.extension)) continue;
    if (file.size > 200 * 1024) continue; // skip big files

    const content = safeRead(file.path);
    if (!content) continue;

    for (const risk of SECURITY_RISKS) {
      const matches = content.match(risk.regex);
      if (matches) {
        findings.push({
          id: risk.id,
          severity: risk.severity,
          message: risk.message,
          file: file.relative || file.path,
          count: matches.length,
          sample: matches[0].slice(0, 80),
        });
      }
    }
  }

  return findings;
}

// ============ CODE QUALITY ============
function codeQuality(files) {
  const jsFiles = files.filter((f) =>
    ['.js', '.ts', '.mjs', '.cjs'].includes(f.extension)
  );

  const totalLines = jsFiles.length; // placeholder
  const hasTests = files.some((f) => /\.(test|spec)\./i.test(f.name));
  const hasLinter = files.some((f) =>
    /\.eslintrc|\.prettierrc/i.test(f.name)
  );
  const hasTypeScript = files.some((f) => f.extension === '.ts');
  const hasTsConfig = files.some((f) => f.name === 'tsconfig.json');
  const hasReadme = files.some((f) => /^readme/i.test(f.name));
  const hasLicense = files.some((f) => /^license/i.test(f.name));

  const score = {
    hasTests,
    hasLinter,
    hasTypeScript: hasTypeScript && hasTsConfig,
    hasReadme,
    hasLicense,
    jsFileCount: jsFiles.length,
  };

  const issues = [];
  if (!hasTests) issues.push('No test files detected — add tests');
  if (!hasLinter) issues.push('No linter config — add ESLint/Prettier');
  if (!hasReadme) issues.push('No README.md — document your project');
  if (!hasLicense) issues.push('No LICENSE file');
  if (hasTypeScript && !hasTsConfig) issues.push('TypeScript files but no tsconfig.json');

  return { score, issues };
}

// ============ DEAD CODE / ORPHAN DETECTION ============
function detectOrphans(files, rootDir) {
  // Simple: files not referenced anywhere
  const jsFiles = files.filter((f) =>
    ['.js', '.ts', '.mjs', '.cjs'].includes(f.extension)
  );

  const entryPoints = ['index.js', 'server.js', 'app.js', 'main.js', 'cli.js'];
  const referenced = new Set();

  // Collect all imports/requires
  for (const file of jsFiles) {
    if (file.size > 200 * 1024) continue;
    const content = safeRead(file.path);
    if (!content) continue;

    // require('...') / import '...'
    const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    const importRe = /from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = requireRe.exec(content))) referenced.add(m[1]);
    while ((m = importRe.exec(content))) referenced.add(m[1]);
  }

  const orphans = [];
  for (const file of jsFiles) {
    if (entryPoints.includes(file.name)) continue;

    const base = file.name.replace(/\.(js|ts|mjs|cjs)$/, '');
    const rel = file.relative || '';

    const isReferenced =
      referenced.has(file.name) ||
      referenced.has(base) ||
      [...referenced].some((r) => r.endsWith(file.name) || r.endsWith(base));

    if (!isReferenced) {
      orphans.push({
        file: file.relative || file.name,
        size: file.size,
      });
    }
  }

  return orphans.slice(0, 30);
}

// ============ ARCHITECTURE ANALYSIS ============
function analyzeArchitecture(files, rootDir) {
  const topDirs = new Set();
  for (const f of files) {
    const rel = path.relative(rootDir, f.path);
    const top = rel.split(path.sep)[0];
    if (top && top !== f.name) topDirs.add(top);
  }

  const structure = [...topDirs].sort();
  const hasSrc = structure.includes('src');
  const hasLib = structure.includes('lib');
  const hasTests = structure.some((d) => /test|spec/i.test(d));
  const hasDocs = structure.some((d) => /doc/i.test(d));

  const type =
    hasSrc ? 'structured' :
    structure.length > 3 ? 'modular' :
    'flat';

  return {
    type,
    topLevelDirs: structure,
    hasSrc,
    hasLib,
    hasTests,
    hasDocs,
    totalTopLevel: structure.length,
  };
}

// ============ MAIN ANALYZER ============
module.exports = {
  /**
   * Full project analysis
   * @param {Object} opts
   * @param {string[]} opts.requiredSkills - Skills that MUST be present
   * @param {boolean} opts.deep - Include security audit + orphan detection
   * @param {string} opts.rootDir - Project root (default: cwd)
   */
  analyze(opts = {}) {
    const rootDir = opts.rootDir || process.cwd();
    const requiredSkills = opts.requiredSkills || [
      'pdfReader',
      'imageAnalyzer',
      'browserAgent',
      'database',
      'authentication',
    ];
    const deep = opts.deep !== false; // default true

    const startTime = Date.now();

    // 1) Scan files
    const files = projectScanner.scanProject();

    // 2) Read package.json
    const pkg = readPackageJson(rootDir);
    const deps = getDependencies(pkg);

    // 3) Detect skills
    const detectedSkills = detectSkills(files, deps);

    // 4) Missing skills
    const missingSkills = findMissingSkills(detectedSkills, requiredSkills);

    // 5) Reports
    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      durationMs: 0,

      overview: {
        totalFiles: files.length,
        totalSize: projectScanner.formatBytes(
          files.reduce((s, f) => s + f.size, 0)
        ),
        projectName: pkg?.name || 'unknown',
        projectVersion: pkg?.version || '0.0.0',
        dependencies: Object.keys(deps).length,
      },

      skills: {
        detected: detectedSkills,
        detectedCount: Object.keys(detectedSkills).length,
        missing: missingSkills,
        missingCount: missingSkills.length,
        coverage: `${Math.round(
          ((requiredSkills.length - missingSkills.length) / requiredSkills.length) * 100
        )}%`,
      },

      quality: codeQuality(files),
      architecture: analyzeArchitecture(files, rootDir),

      warnings: [],
      suggestions: [],
    };

    // 6) Deep analysis
    if (deep) {
      report.security = {
        findings: securityAudit(files, rootDir),
      };
      report.security.total = report.security.findings.length;
      report.security.critical = report.security.findings.filter(
        (f) => f.severity === 'critical'
      ).length;

      report.orphans = detectOrphans(files, rootDir);
    }

    // 7) Build suggestions
    for (const m of missingSkills) {
      report.suggestions.push({
        type: 'missing-skill',
        priority: m.priority,
        message: `${m.skill}: ${m.description}`,
        action: m.suggestion,
      });
    }

    for (const issue of report.quality.issues) {
      report.suggestions.push({
        type: 'quality',
        priority: 'medium',
        message: issue,
      });
    }

    if (deep && report.security.critical > 0) {
      report.warnings.push({
        level: 'critical',
        message: `${report.security.critical} critical security issue(s) found`,
      });
    }

    if (deep && report.orphans.length > 5) {
      report.warnings.push({
        level: 'info',
        message: `${report.orphans.length} possibly unused files detected`,
      });
    }

    // 8) Overall score (0-100)
    report.score = calculateScore(report, requiredSkills);

    report.durationMs = Date.now() - startTime;

    return report;
  },

  // Expose registry for extension
  SKILL_REGISTRY,
  detectSkills,
  securityAudit,
};

// ============ SCORING ============
function calculateScore(report, requiredSkills) {
  let score = 100;

  // Skill coverage (up to -40)
  const missing = report.skills.missingCount;
  score -= Math.min(40, missing * 8);

  // Quality (up to -20)
  score -= report.quality.issues.length * 4;

  // Security (up to -30)
  if (report.security) {
    const c = report.security.findings.filter((f) => f.severity === 'critical').length;
    const h = report.security.findings.filter((f) => f.severity === 'high').length;
    const m = report.security.findings.filter((f) => f.severity === 'medium').length;
    score -= Math.min(30, c * 10 + h * 5 + m * 2);
  }

  // Architecture bonus
  if (report.architecture.hasTests) score += 5;
  if (report.architecture.hasSrc) score += 3;

  return Math.max(0, Math.min(100, score));
}

