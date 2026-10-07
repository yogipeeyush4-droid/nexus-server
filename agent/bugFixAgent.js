const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const selfAnalyzer = require('../core/selfAnalyzer');

// ============ CONFIG ============
const CONFIG = {
  maxFileSizeBytes: 500 * 1024,        // skip > 500KB
  scanExtensions: ['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx'],
  ignoreDirs: ['node_modules', '.git', 'dist', 'build', 'coverage'],
  minConfidence: 0.4,
  maxBugs: 500,
  patchDir: path.join(process.cwd(), '.bugfix-patches'),
  autoPatch: false,                    // safety: off by default
  logLevel: process.env.LOG_LEVEL || 'info',
};

// ============ LOGGER ============
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CL = LEVELS[CONFIG.logLevel] || 2;
function log(level, msg, meta) {
  if (LEVELS[level] > CL) return;
  const line = meta
    ? `[BugFix] ${level.toUpperCase()} ${msg} ${JSON.stringify(meta)}`
    : `[BugFix] ${level.toUpperCase()} ${msg}`;
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

// ============ BUG RULES ============
// Each rule: { id, category, severity, detect(content, file), confidence }
const BUG_RULES = [
  // ---------- Async / Promise ----------
  {
    id: 'await-in-loop',
    category: 'performance',
    severity: 'medium',
    message: 'await inside loop — use Promise.all for parallel',
    regex: /for\s*\([^)]*\)\s*\{[^}]*\bawait\b/s,
    confidence: 0.7,
    fix: 'Collect promises and use `await Promise.all([...])` outside the loop.',
  },
  {
    id: 'missing-await',
    category: 'async',
    severity: 'high',
    message: 'Possible missing await on async call',
    regex: /(?<!await\s)(?<!return\s)\b(?:fetch|axios|readFile|writeFile|query|save|remove|find)\s*\([^;]*\)\s*;/g,
    confidence: 0.5,
    fix: 'Add `await` before the async call, or handle the promise with `.then()`.',
  },
  {
    id: 'promise-no-catch',
    category: 'async',
    severity: 'high',
    message: 'Promise chain without .catch() — unhandled rejection risk',
    regex: /\.then\s*\([^)]*\)\s*;(?!.*\.catch)/g,
    confidence: 0.6,
    fix: 'Add `.catch(err => ...)` or wrap in try/catch with async/await.',
  },
  {
    id: 'floating-promise',
    category: 'async',
    severity: 'medium',
    message: 'Floating promise — errors may be silently lost',
    regex: /^\s*(?:async\s+)?[a-zA-Z_$][\w$]*\s*\([^)]*\)\s*;\s*$/gm,
    confidence: 0.3,
    fix: 'Add `await`, `.catch()`, or prefix with `void` if intentional.',
  },

  // ---------- Error Handling ----------
  {
    id: 'empty-catch',
    category: 'error-handling',
    severity: 'high',
    message: 'Empty catch block swallows errors',
    regex: /catch\s*\([^)]*\)\s*\{\s*\}/g,
    confidence: 0.95,
    fix: 'Log the error or rethrow: `catch (err) { console.error(err); throw err; }`',
  },
  {
    id: 'catch-no-param',
    category: 'error-handling',
    severity: 'low',
    message: 'Catch without error param — cannot inspect failure',
    regex: /catch\s*\{\s*[^}]+?\s*\}/g,
    confidence: 0.5,
    fix: 'Use `catch (err)` to capture the error object.',
  },
  {
    id: 'throw-string',
    category: 'error-handling',
    severity: 'medium',
    message: 'Throwing a string instead of Error object',
    regex: /throw\s+['"`][^'"`]+['"`]/g,
    confidence: 0.9,
    fix: 'Throw `new Error("message")` — better stack traces.',
  },

  // ---------- Security ----------
  {
    id: 'eval-usage',
    category: 'security',
    severity: 'critical',
    message: 'eval() — code injection risk',
    regex: /\beval\s*\(/g,
    confidence: 0.95,
    fix: 'Replace with safe alternatives: JSON.parse, Function constructor with validation.',
  },
  {
    id: 'innerHTML',
    category: 'security',
    severity: 'high',
    message: 'innerHTML — XSS vulnerability',
    regex: /\.innerHTML\s*=/g,
    confidence: 0.7,
    fix: 'Use `.textContent` or sanitize with DOMPurify.',
  },
  {
    id: 'dangerous-child-process',
    category: 'security',
    severity: 'high',
    message: 'child_process with user input — command injection',
    regex: /exec\s*\(\s*[`'"][^)]*\$\{/g,
    confidence: 0.8,
    fix: 'Use `execFile` with argument array instead of shell string interpolation.',
  },
  {
    id: 'hardcoded-secret',
    category: 'security',
    severity: 'critical',
    message: 'Hardcoded secret/key/password',
    regex: /(?:api[_-]?key|secret|password|token|passwd)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    confidence: 0.85,
    fix: 'Move to `.env` and use `process.env.SECRET_NAME`.',
  },
  {
    id: 'sql-injection',
    category: 'security',
    severity: 'critical',
    message: 'SQL query with string interpolation',
    regex: /(?:query|execute)\s*\(\s*[`'"][^'"`]*\$\{/g,
    confidence: 0.8,
    fix: 'Use parameterized queries: `db.query("... WHERE id = ?", [id])`.',
  },
  {
    id: 'weak-crypto',
    category: 'security',
    severity: 'medium',
    message: 'MD5/SHA1 — weak hashing',
    regex: /createHash\s*\(\s*['"](?:md5|sha1)['"]/gi,
    confidence: 0.9,
    fix: 'Use SHA-256 or bcrypt/argon2 for passwords.',
  },
  {
    id: 'http-not-https',
    category: 'security',
    severity: 'medium',
    message: 'Insecure HTTP URL',
    regex: /['"]http:\/\/(?!localhost|127\.|0\.0\.0\.0)[^'"]+['"]/g,
    confidence: 0.7,
    fix: 'Use HTTPS for production endpoints.',
  },
  {
    id: 'cors-wildcard',
    category: 'security',
    severity: 'medium',
    message: 'CORS wildcard origin',
    regex: /origin\s*:\s*['"]\*['"]/g,
    confidence: 0.9,
    fix: 'Whitelist specific origins.',
  },
  {
    id: 'dangerously-set-html',
    category: 'security',
    severity: 'high',
    message: 'dangerouslySetInnerHTML — XSS risk',
    regex: /dangerouslySetInnerHTML/g,
    confidence: 0.85,
    fix: 'Sanitize HTML before rendering.',
  },

  // ---------- Code Smells ----------
  {
    id: 'console-log',
    category: 'code-smell',
    severity: 'low',
    message: 'console.log left in production code',
    regex: /console\.log\s*\(/g,
    confidence: 0.6,
    fix: 'Use a proper logger (winston/pino) or remove.',
  },
  {
    id: 'debugger',
    category: 'code-smell',
    severity: 'high',
    message: 'debugger statement left in code',
    regex: /^\s*debugger\s*;?\s*$/gm,
    confidence: 1.0,
    fix: 'Remove debugger statement.',
  },
  {
    id: 'var-usage',
    category: 'code-smell',
    severity: 'low',
    message: 'var instead of let/const',
    regex: /(?:^|\s|;|\{)var\s+[a-zA-Z_$]/g,
    confidence: 0.9,
    fix: 'Use `let` or `const` for block scoping.',
  },
  {
    id: 'loose-equality',
    category: 'code-smell',
    severity: 'low',
    message: 'Loose equality (==) may cause coercion bugs',
    regex: /[^=!<>]==[^=]/g,
    confidence: 0.5,
    fix: 'Use strict equality `===`.',
  },
  {
    id: 'todo-fixme',
    category: 'tech-debt',
    severity: 'low',
    message: 'TODO/FIXME comment',
    regex: /\/\/\s*(TODO|FIXME|XXX|HACK)\b/gi,
    confidence: 0.7,
    fix: 'Address or track in your issue tracker.',
  },
  {
    id: 'commented-code',
    category: 'code-smell',
    severity: 'low',
    message: 'Large block of commented-out code',
    regex: /(?:\/\/[^\n]*\n){5,}/g,
    confidence: 0.4,
    fix: 'Delete dead code — Git keeps history.',
  },

  // ---------- Logic / Correctness ----------
  {
    id: 'assign-in-condition',
    category: 'logic',
    severity: 'high',
    message: 'Assignment (=) in condition — likely meant ===',
    regex: /if\s*\([^)]*(?<![=!<>+\-*/])=(?![=])[^)]*\)/g,
    confidence: 0.7,
    fix: 'Use `===` for comparison, or `==` if intentional assignment.',
  },
  {
    id: 'no-return-function',
    category: 'logic',
    severity: 'low',
    message: 'Function named like getter/has/check without return',
    regex: /(?:function|const)\s+(?:get|is|has|should)[A-Z]\w*\s*[=(][^{]*\{[^}]*\}/g,
    confidence: 0.3,
    fix: 'Verify the function returns a value.',
  },
  {
    id: 'array-index-of-check',
    category: 'logic',
    severity: 'medium',
    message: 'Using indexOf as truthy — `-1` is truthy',
    regex: /if\s*\(\s*[\w.]+\.indexOf\s*\([^)]*\)\s*\)/g,
    confidence: 0.8,
    fix: 'Use `.includes()` or check `!== -1`.',
  },
  {
    id: 'type-of-compare',
    category: 'logic',
    severity: 'medium',
    message: 'typeof comparison case error',
    regex: /typeof\s+\w+\s*[!=]==?\s*['"](?:Number|String|Boolean|Object|Array|Function)['"]/g,
    confidence: 0.95,
    fix: 'Use lowercase: "number", "string", "boolean", "object", "function".',
  },

  // ---------- Performance ----------
  {
    id: 'sync-fs',
    category: 'performance',
    severity: 'medium',
    message: 'Synchronous fs call in hot path',
    regex: /\bfs\.(?:readFileSync|writeFileSync|existsSync|statSync|readdirSync)\s*\(/g,
    confidence: 0.6,
    fix: 'Use async counterparts: `fs.promises.readFile` etc.',
  },
  {
    id: 'json-stringify-loop',
    category: 'performance',
    severity: 'low',
    message: 'JSON.stringify inside loop',
    regex: /for\s*\([^)]*\)\s*\{[^}]*JSON\.stringify/s,
    confidence: 0.5,
    fix: 'Hoist or use a builder pattern.',
  },
  {
    id: 'regex-in-loop',
    category: 'performance',
    severity: 'medium',
    message: 'RegExp literal created inside loop',
    regex: /for\s*\([^)]*\)\s*\{[^}]*=\s*\/[^/]+\/[gimsuy]*/s,
    confidence: 0.5,
    fix: 'Hoist the RegExp outside the loop.',
  },

  // ---------- React / Frontend ----------
  {
    id: 'react-index-key',
    category: 'react',
    severity: 'medium',
    message: 'Using array index as React key',
    regex: /key\s*=\s*\{\s*(?:i|idx|index)\s*\}/g,
    confidence: 0.8,
    fix: 'Use stable unique IDs: `key={item.id}`.',
  },
  {
    id: 'missing-deps-effect',
    category: 'react',
    severity: 'medium',
    message: 'useEffect with missing/empty deps array may be stale',
    regex: /useEffect\s*\(\s*\(\s*\)\s*=>\s*\{[^}]*\}\s*,\s*\[\s*\]\s*\)/g,
    confidence: 0.4,
    fix: 'Verify intentional — add deps or use refs.',
  },

  // ---------- Node / API ----------
  {
    id: 'no-error-handler',
    category: 'node',
    severity: 'medium',
    message: 'Event listener without .on("error")',
    regex: /\.on\s*\(\s*['"](?:data|end)['"][^)]*\)/g,
    confidence: 0.4,
    fix: 'Add `.on("error", handler)` for streams/emitters.',
  },
  {
    id: 'async-handler-no-catch',
    category: 'node',
    severity: 'high',
    message: 'Express async route without try/catch — unhandled rejection',
    regex: /(?:app|router)\.(?:get|post|put|delete|patch)\s*\(\s*['"][^'"]+['"]\s*,\s*async\s*\([^)]*\)\s*=>\s*\{(?![^}]*try)/g,
    confidence: 0.6,
    fix: 'Wrap in try/catch or use an asyncHandler wrapper.',
  },

  // ---------- Browser / DOM ----------
  {
    id: 'doc-write',
    category: 'browser',
    severity: 'high',
    message: 'document.write — blocks rendering',
    regex: /document\.write\s*\(/g,
    confidence: 0.9,
    fix: 'Use DOM APIs: `element.append(...)`.',
  },
  {
    id: 'settimeout-string',
    category: 'browser',
    severity: 'medium',
    message: 'setTimeout with string — eval-like behavior',
    regex: /set(?:Timeout|Interval)\s*\(\s*['"]/g,
    confidence: 0.85,
    fix: 'Pass a function: `setTimeout(() => {...}, 100)`.',
  },
];

// ============ SEVERITY RANKS ============
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

// ============ HASH ============
function uid(p = 'bug') {
  return `${p}_${crypto.randomBytes(4).toString('hex')}`;
}

function fingerprint(bug) {
  return crypto
    .createHash('sha1')
    .update(`${bug.ruleId}::${bug.file}::${bug.line}`)
    .digest('hex')
    .slice(0, 12);
}

// ============ HELPERS ============
function shouldScan(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!CONFIG.scanExtensions.includes(ext)) return false;
  if (CONFIG.ignoreDirs.some((d) => filePath.includes(`/${d}/`))) return false;
  return true;
}

function getLineNumber(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

function getContextLines(content, lineNum, radius = 2) {
  const lines = content.split('\n');
  const start = Math.max(0, lineNum - 1 - radius);
  const end = Math.min(lines.length, lineNum + radius);
  return lines
    .slice(start, end)
    .map((l, i) => {
      const n = start + i + 1;
      return `${n === lineNum ? '→' : ' '} ${n}: ${l}`;
    })
    .join('\n');
}

// ============ RULE EXECUTION ============
function runRule(rule, content, file) {
  const bugs = [];

  // Regex-based
  if (rule.regex) {
    const re = new RegExp(rule.regex.source, rule.regex.flags.includes('g') ? rule.regex.flags : rule.regex.flags + 'g');
    let match;
    let count = 0;
    while ((match = re.exec(content)) !== null && count < 50) {
      count++;

      const line = getLineNumber(content, match.index);
      const snippet = (match[0] || '').trim().slice(0, 120);

      bugs.push({
        id: uid(),
        ruleId: rule.id,
        category: rule.category,
        severity: rule.severity,
        message: rule.message,
        file: file.relative || file.path,
        absPath: file.path,
        line,
        snippet,
        context: getContextLines(content, line),
        confidence: rule.confidence,
        fix: rule.fix || null,
      });

      if (match.index === re.lastIndex) re.lastIndex++;
    }
  }

  // Custom detector function
  if (typeof rule.detect === 'function') {
    try {
      const detected = rule.detect(content, file) || [];
      for (const d of detected) {
        bugs.push({
          id: uid(),
          ruleId: rule.id,
          category: rule.category,
          severity: rule.severity,
          message: d.message || rule.message,
          file: file.relative || file.path,
          absPath: file.path,
          line: d.line || 1,
          snippet: d.snippet || '',
          context: d.context || '',
          confidence: d.confidence ?? rule.confidence,
          fix: d.fix || rule.fix || null,
        });
      }
    } catch (err) {
      log('warn', `rule ${rule.id} threw`, { err: err.message });
    }
  }

  return bugs;
}

// ============ SIMPLE AST-LITE CHECKS ============
function astChecks(content, file) {
  const bugs = [];

  // Unbalanced braces/brackets
  const open = (content.match(/\{/g) || []).length;
  const close = (content.match(/\}/g) || []).length;
  if (open !== close) {
    bugs.push({
      id: uid(),
      ruleId: 'unbalanced-braces',
      category: 'syntax',
      severity: 'critical',
      message: `Unbalanced braces: ${open} open vs ${close} close`,
      file: file.relative || file.path,
      absPath: file.path,
      line: 1,
      snippet: '',
      context: '',
      confidence: 0.9,
      fix: 'Fix brace imbalance — code may not parse.',
    });
  }

  // Syntax check via Function constructor (JS only)
  if (/\.(js|cjs|mjs)$/i.test(file.path)) {
    try {
      // eslint-disable-next-line no-new-func
      new Function(content);
    } catch (err) {
      const lineMatch = err.message.match(/line (\d+)/);
      const line = lineMatch ? parseInt(lineMatch[1], 10) : 1;
      bugs.push({
        id: uid(),
        ruleId: 'syntax-error',
        category: 'syntax',
        severity: 'critical',
        message: `Syntax error: ${err.message}`,
        file: file.relative || file.path,
        absPath: file.path,
        line,
        snippet: '',
        context: getContextLines(content, line),
        confidence: 1.0,
        fix: 'Fix syntax error — file will not load.',
      });
    }
  }

  return bugs;
}

// ============ DEDUPE + CAP ============
function dedupe(bugs) {
  const seen = new Map();
  for (const b of bugs) {
    const fp = fingerprint(b);
    if (!seen.has(fp)) seen.set(fp, b);
  }
  return [...seen.values()];
}

// ============ SORT ============
function sortBugs(bugs) {
  return bugs.sort((a, b) => {
    const sd = (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99);
    if (sd !== 0) return sd;
    return (b.confidence || 0) - (a.confidence || 0);
  });
}

// ============ GROUPING ============
function groupBy(bugs, key) {
  const groups = {};
  for (const b of bugs) {
    const k = b[key] || 'unknown';
    if (!groups[k]) groups[k] = [];
    groups[k].push(b);
  }
  return groups;
}

// ============ PATCH SUGGESTION ============
function buildPatchSuggestion(bug) {
  if (!bug.fix) return null;
  return {
    bugId: bug.id,
    file: bug.file,
    line: bug.line,
    currentLine: bug.snippet,
    suggestion: bug.fix,
    severity: bug.severity,
    confidence: bug.confidence,
  };
}

// ============ CATEGORY SUMMARY ============
function summarize(bugs) {
  const bySeverity = {};
  const byCategory = {};
  const byFile = {};
  const byRule = {};

  let totalConfidence = 0;

  for (const b of bugs) {
    bySeverity[b.severity] = (bySeverity[b.severity] || 0) + 1;
    byCategory[b.category] = (byCategory[b.category] || 0) + 1;
    byFile[b.file] = (byFile[b.file] || 0) + 1;
    byRule[b.ruleId] = (byRule[b.ruleId] || 0) + 1;
    totalConfidence += b.confidence || 0;
  }

  const topFiles = Object.entries(byFile)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, count]) => ({ file, count }));

  const topRules = Object.entries(byRule)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([rule, count]) => ({ rule, count }));

  // Health score (0 = terrible, 100 = clean)
  const criticalWeight = (bySeverity.critical || 0) * 10;
  const highWeight = (bySeverity.high || 0) * 5;
  const mediumWeight = (bySeverity.medium || 0) * 2;
  const lowWeight = (bySeverity.low || 0) * 0.5;
  const penalty = criticalWeight + highWeight + mediumWeight + lowWeight;
  const score = Math.max(0, Math.round(100 - penalty));

  return {
    total: bugs.length,
    bySeverity,
    byCategory,
    topFiles,
    topRules,
    avgConfidence: bugs.length > 0 ? +(totalConfidence / bugs.length).toFixed(2) : 0,
    healthScore: score,
  };
}

// ============ FILE READER ============
async function readFile(file) {
  if (file.size > CONFIG.maxFileSizeBytes) return null;
  try {
    return await fsp.readFile(file.path, 'utf8');
  } catch (err) {
    log('warn', 'read failed', { file: file.path, err: err.message });
    return null;
  }
}

// ============ MAIN AGENT ============
class BugFixAgent {
  constructor() {
    this.stats = {
      totalScans: 0,
      totalBugs: 0,
      bySeverity: {},
      byCategory: {},
    };
    this.lastReport = null;
  }

  /**
   * Scan project for bugs.
   * @param {Object} opts
   *  - report: pre-computed selfAnalyzer report
   *  - deep: pass to selfAnalyzer
   *  - file: scan only one file (path)
   *  - minConfidence: filter
   *  - categories: ['security', ...]
   *  - severities: ['critical', 'high']
   *  - includeContext: include source context
   */
  async scanBugs(opts = {}) {
    const t0 = Date.now();
    log('info', 'bug scan started');

    // 1) Self-analysis (for security findings)
    let analysis = opts.report;
    if (!analysis) {
      try {
        analysis = selfAnalyzer.analyze({ deep: opts.deep !== false });
      } catch (err) {
        log('warn', 'selfAnalyzer failed', { err: err.message });
        analysis = null;
      }
    }

    // 2) Get files to scan
    let files;
    if (opts.file) {
      const stats = fs.statSync(opts.file);
      files = [{ name: path.basename(opts.file), path: opts.file, size: stats.size }];
    } else {
      const projectScanner = require('../core/projectScanner');
      files = projectScanner.scanProject();
    }

    files = files.filter((f) => shouldScan(f.path));

    // 3) Scan each file
    const allBugs = [];

    for (const file of files) {
      const content = await readFile(file);
      if (!content) continue;

      // Run regex/detector rules
      for (const rule of BUG_RULES) {
        const found = runRule(rule, content, file);
        allBugs.push(...found);
      }

      // AST-lite checks
      const astBugs = astChecks(content, file);
      allBugs.push(...astBugs);
    }

    // 4) Include selfAnalyzer security findings
    if (analysis?.security?.findings) {
      for (const f of analysis.security.findings) {
        allBugs.push({
          id: uid(),
          ruleId: `selfanalyzer:${f.id || 'unknown'}`,
          category: 'security',
          severity: f.severity || 'medium',
          message: f.message || 'Security finding',
          file: f.file || 'unknown',
          absPath: null,
          line: 0,
          snippet: f.sample || '',
          context: '',
          confidence: 0.85,
          fix: null,
          source: 'selfAnalyzer',
        });
      }
    }

    // 5) Include selfAnalyzer quality issues
    if (analysis?.quality?.issues) {
      for (const issue of analysis.quality.issues) {
        allBugs.push({
          id: uid(),
          ruleId: 'selfanalyzer:quality',
          category: 'quality',
          severity: 'medium',
          message: issue,
          file: 'project',
          absPath: null,
          line: 0,
          snippet: '',
          context: '',
          confidence: 0.7,
          fix: null,
          source: 'selfAnalyzer',
        });
      }
    }

    // 6) Filter
    let bugs = allBugs;

    if (opts.categories?.length) {
      bugs = bugs.filter((b) => opts.categories.includes(b.category));
    }
    if (opts.severities?.length) {
      bugs = bugs.filter((b) => opts.severities.includes(b.severity));
    }
    if (opts.minConfidence != null) {
      bugs = bugs.filter((b) => b.confidence >= opts.minConfidence);
    } else {
      bugs = bugs.filter((b) => b.confidence >= CONFIG.minConfidence);
    }

    // 7) Dedupe + sort + cap
    bugs = dedupe(bugs);
    bugs = sortBugs(bugs);
    bugs = bugs.slice(0, CONFIG.maxBugs);

    // 8) Summary
    const summary = summarize(bugs);

    // 9) Patch suggestions
    const patches = bugs.map(buildPatchSuggestion).filter(Boolean);

    // 10) Build report
    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      filesScanned: files.length,

      total: bugs.length,
      bugs,
      summary,
      patches,

      bySeverity: groupBy(bugs, 'severity'),
      byCategory: groupBy(bugs, 'category'),
      byFile: groupBy(bugs, 'file'),

      healthScore: summary.healthScore,
    };

    // 11) Stats
    this.stats.totalScans++;
    this.stats.totalBugs += bugs.length;
    for (const b of bugs) {
      this.stats.bySeverity[b.severity] = (this.stats.bySeverity[b.severity] || 0) + 1;
      this.stats.byCategory[b.category] = (this.stats.byCategory[b.category] || 0) + 1;
    }
    this.lastReport = report;

    log('info', 'bug scan complete', {
      total: bugs.length,
      durationMs: report.durationMs,
      score: summary.healthScore,
    });

    return report;
  }

  /**
   * Quick scan — critical/high only.
   */
  async quickScan() {
    return this.scanBugs({
      severities: ['critical', 'high'],
      deep: false,
    });
  }

  /**
   * Security-only scan.
   */
  async securityScan() {
    return this.scanBugs({
      categories: ['security'],
      deep: true,
    });
  }

  /**
   * Scan a single file.
   */
  async scanFile(filePath) {
    return this.scanBugs({ file: filePath });
  }

  /**
   * Get patch for one bug.
   */
  getFix(bugId) {
    if (!this.lastReport) return null;
    const bug = this.lastReport.bugs.find((b) => b.id === bugId);
    if (!bug) return null;
    return buildPatchSuggestion(bug);
  }

  /**
   * Export patches to disk.
   */
  async exportPatches(bugs = null) {
    const list = bugs || this.lastReport?.patches || [];
    await fsp.mkdir(CONFIG.patchDir, { recursive: true });

    const file = path.join(
      CONFIG.patchDir,
      `patches-${Date.now()}.json`
    );
    await fsp.writeFile(file, JSON.stringify(list, null, 2));
    log('info', 'patches exported', { file, count: list.length });
    return { ok: true, file, count: list.length };
  }

  /**
   * Generate markdown bug report.
   */
  toMarkdown(report = null) {
    const r = report || this.lastReport;
    if (!r) return '# No report available';

    const lines = [];
    lines.push(`# 🐛 Bug Report`);
    lines.push('');
    lines.push(`**Generated:** ${r.generatedAt}  `);
    lines.push(`**Files scanned:** ${r.filesScanned}  `);
    lines.push(`**Health Score:** \`${r.healthScore}/100\`  `);
    lines.push(`**Total bugs:** ${r.total}  `);
    lines.push('');
    lines.push('## 📊 Summary');
    lines.push('');
    lines.push('### By Severity');
    for (const [sev, count] of Object.entries(r.summary.bySeverity)) {
      lines.push(`- **${sev}**: ${count}`);
    }
    lines.push('');
    lines.push('### By Category');
    for (const [cat, count] of Object.entries(r.summary.byCategory)) {
      lines.push(`- ${cat}: ${count}`);
    }
    lines.push('');
    lines.push('## 🐞 Bugs');
    lines.push('');

    const grouped = r.bySeverity;
    for (const sev of ['critical', 'high', 'medium', 'low']) {
      if (!grouped[sev]) continue;
      lines.push(`### ${sev.toUpperCase()} (${grouped[sev].length})`);
      lines.push('');
      for (const b of grouped[sev].slice(0, 30)) {
        lines.push(`- **[${b.ruleId}]** \`${b.file}:${b.line}\``);
        lines.push(`  ${b.message}`);
        if (b.fix) lines.push(`  💡 _Fix: ${b.fix}_`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  getStats() {
    return { ...this.stats, lastReportTotal: this.lastReport?.total || 0 };
  }

  getRules() {
    return BUG_RULES.map((r) => ({
      id: r.id,
      category: r.category,
      severity: r.severity,
      message: r.message,
      confidence: r.confidence,
    }));
  }
}

// ============ EXPORT ============
const agent = new BugFixAgent();
agent.BUG_RULES = BUG_RULES;
agent.CONFIG = CONFIG;

module.exports = agent;

