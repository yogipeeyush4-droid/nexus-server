const crypto = require('crypto');
const selfAnalyzer = require('../core/selfAnalyzer');
const memoryManager = require('../core/memoryManager');

// ============ CONFIG ============
const CONFIG = {
  defaultPhase: 'improvement',
  effortWeights: {
    critical: 8,
    high: 5,
    medium: 3,
    low: 1,
  },
  priorityRank: { critical: 0, high: 1, medium: 2, low: 3 },
  maxTasks: 200,
  autoGroupParallel: true,
};

// ============ TASK BLUEPRINTS ============
// Predefined recipes for common task types
const TASK_BLUEPRINTS = {
  'create-skill': {
    phase: 'capability',
    effort: 'medium',
    risk: 'low',
    dependsOn: [],
    tags: ['skill', 'feature'],
    deliverables: ['skill module', 'tests', 'docs'],
  },
  'security-fix': {
    phase: 'stabilize',
    effort: 'high',
    risk: 'high',
    dependsOn: [],
    tags: ['security', 'urgent'],
    deliverables: ['patch', 'audit log', 'regression test'],
    blocking: true,         // must complete before other phases
  },
  'quality-improvement': {
    phase: 'improve',
    effort: 'low',
    risk: 'low',
    dependsOn: ['security-fix'],
    tags: ['quality'],
    deliverables: ['refactor', 'test coverage'],
  },
  'add-tests': {
    phase: 'improve',
    effort: 'medium',
    risk: 'low',
    dependsOn: ['security-fix'],
    tags: ['testing', 'quality'],
  },
  'refactor': {
    phase: 'improve',
    effort: 'high',
    risk: 'medium',
    dependsOn: ['add-tests'],
    tags: ['refactor'],
  },
  'cleanup-orphans': {
    phase: 'optimize',
    effort: 'low',
    risk: 'medium',
    dependsOn: ['add-tests', 'quality-improvement'],
    tags: ['cleanup'],
  },
  'add-linter': {
    phase: 'improve',
    effort: 'low',
    risk: 'low',
    dependsOn: [],
    tags: ['quality', 'tooling'],
  },
  'add-docs': {
    phase: 'polish',
    effort: 'low',
    risk: 'low',
    dependsOn: [],
    tags: ['docs'],
  },
  'add-ci': {
    phase: 'devops',
    effort: 'medium',
    risk: 'low',
    dependsOn: ['add-linter', 'add-tests'],
    tags: ['ci', 'devops'],
  },
  'performance': {
    phase: 'optimize',
    effort: 'high',
    risk: 'medium',
    dependsOn: ['add-tests'],
    tags: ['performance'],
  },
};

// ============ PHASES ============
const PHASE_ORDER = ['stabilize', 'capability', 'improve', 'optimize', 'devops', 'polish', 'improvement'];

function phaseRank(phase) {
  const idx = PHASE_ORDER.indexOf(phase);
  return idx === -1 ? 999 : idx;
}

// ============ UTILS ============
function uid(prefix = 't') {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

function task(partial) {
  const bp = TASK_BLUEPRINTS[partial.type] || {};
  return {
    id: partial.id || uid(),
    type: partial.type,
    title: partial.title || partial.type,
    priority: partial.priority || 'medium',
    phase: partial.phase || bp.phase || CONFIG.defaultPhase,
    effort: partial.effort || bp.effort || 'medium',
    risk: partial.risk || bp.risk || 'low',
    tags: [...new Set([...(bp.tags || []), ...(partial.tags || [])])],
    dependsOn: partial.dependsOn || bp.dependsOn || [],
    deliverables: partial.deliverables || bp.deliverables || [],
    blocking: partial.blocking ?? bp.blocking ?? false,
    reason: partial.reason || null,
    target: partial.target || null,
    metadata: partial.metadata || {},
    createdAt: new Date().toISOString(),
  };
}

// ============ TASK GENERATORS ============
function fromMissingSkills(report) {
  const tasks = [];
  const missing = report.skills?.missing || [];

  for (const skill of missing) {
    tasks.push(task({
      type: 'create-skill',
      title: `Create skill: ${skill.skill}`,
      priority: skill.priority || 'medium',
      target: skill.skill,
      reason: skill.description || `Skill "${skill.skill}" missing`,
      metadata: { suggestion: skill.suggestion },
    }));
  }
  return tasks;
}

function fromSecurity(report) {
  const tasks = [];
  const sec = report.security;
  if (!sec) return tasks;

  const findings = sec.findings || [];
  const critical = findings.filter((f) => f.severity === 'critical');
  const high = findings.filter((f) => f.severity === 'high');
  const medium = findings.filter((f) => f.severity === 'medium');

  if (critical.length) {
    tasks.push(task({
      type: 'security-fix',
      title: `Fix ${critical.length} critical security issue(s)`,
      priority: 'critical',
      reason: critical.map((f) => f.message).join('; ').slice(0, 200),
      metadata: { findings: critical.slice(0, 10) },
    }));
  }

  if (high.length) {
    tasks.push(task({
      type: 'security-fix',
      title: `Fix ${high.length} high-risk security issue(s)`,
      priority: 'high',
      metadata: { findings: high.slice(0, 10) },
    }));
  }

  if (medium.length) {
    tasks.push(task({
      type: 'security-fix',
      title: `Review ${medium.length} medium-risk security issue(s)`,
      priority: 'medium',
      metadata: { findings: medium.slice(0, 10) },
    }));
  }

  return tasks;
}

function fromQuality(report) {
  const tasks = [];
  const issues = report.quality?.issues || [];
  const score = report.quality?.score || {};

  for (const issue of issues) {
    const lower = issue.toLowerCase();
    let type = 'quality-improvement';
    let bpPhase;

    if (/test/i.test(issue)) { type = 'add-tests'; bpPhase = 'improve'; }
    else if (/lint|eslint|prettier/i.test(issue)) { type = 'add-linter'; }
    else if (/readme|doc/i.test(issue)) { type = 'add-docs'; }

    tasks.push(task({
      type,
      title: issue,
      priority: 'medium',
      reason: issue,
      phase: bpPhase,
    }));
  }

  // TypeScript without tsconfig, etc.
  if (score.hasTypeScript === false && !issues.some((i) => /typescript/i.test(i))) {
    // nothing — already covered
  }

  return tasks;
}

function fromArchitecture(report) {
  const tasks = [];
  const arch = report.architecture || {};

  if (!arch.hasTests) {
    // Only add if not already added by quality
  }

  if (arch.type === 'flat' && arch.totalTopLevel > 15) {
    tasks.push(task({
      type: 'refactor',
      title: 'Restructure flat project into modules',
      priority: 'low',
      reason: 'Too many top-level files, hard to navigate',
    }));
  }

  return tasks;
}

function fromOrphans(report) {
  const tasks = [];
  const orphans = report.orphans || [];
  if (orphans.length >= 5) {
    tasks.push(task({
      type: 'cleanup-orphans',
      title: `Review ${orphans.length} orphan file(s)`,
      priority: 'low',
      reason: 'Possibly unused files',
      metadata: { files: orphans.slice(0, 10) },
    }));
  }
  return tasks;
}

function fromPerformance(report) {
  const tasks = [];
  const largest = report.stats?.largest;

  if (largest && largest.size > 2 * 1024 * 1024) { // > 2MB
    tasks.push(task({
      type: 'performance',
      title: `Investigate large file: ${largest.path?.split('/').pop()}`,
      priority: 'medium',
      reason: `File is ${(largest.size / 1024 / 1024).toFixed(1)} MB`,
    }));
  }
  return tasks;
}

// ============ DEPENDENCY RESOLVER ============
function resolveDependencies(tasks) {
  const byType = {};
  for (const t of tasks) {
    if (!byType[t.type]) byType[t.type] = [];
    byType[t.type].push(t);
  }

  // Link dependsOn (type → actual task ids)
  for (const t of tasks) {
    const resolved = [];
    for (const dep of t.dependsOn) {
      const matches = byType[dep] || [];
      for (const m of matches) {
        if (m.id !== t.id) resolved.push(m.id);
      }
    }
    t.dependsOn = [...new Set(resolved)];
  }

  return tasks;
}

// ============ CYCLE DETECTION ============
function detectCycles(tasks) {
  const graph = new Map(tasks.map((t) => [t.id, t.dependsOn]));
  const visited = new Set();
  const stack = new Set();
  const cycles = [];

  function dfs(id, path) {
    if (stack.has(id)) {
      cycles.push([...path, id]);
      return;
    }
    if (visited.has(id)) return;

    visited.add(id);
    stack.add(id);
    for (const dep of graph.get(id) || []) {
      dfs(dep, [...path, id]);
    }
    stack.delete(id);
  }

  for (const t of tasks) dfs(t.id, []);
  return cycles;
}

// ============ TOPOLOGICAL SORT ============
function topoSort(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const result = [];
  const visited = new Set();

  function visit(t) {
    if (visited.has(t.id)) return;
    visited.add(t.id);
    for (const depId of t.dependsOn) {
      const dep = byId.get(depId);
      if (dep) visit(dep);
    }
    result.push(t);
  }

  for (const t of tasks) visit(t);
  return result;
}

// ============ EXECUTION WAVES (PARALLEL GROUPS) ============
function computeWaves(tasks) {
  const waves = [];
  const done = new Set();
  let remaining = [...tasks];

  while (remaining.length) {
    const ready = remaining.filter((t) =>
      t.dependsOn.every((d) => done.has(d))
    );

    if (ready.length === 0) {
      // Break deadlock (cycle) — force first
      waves.push([remaining[0]]);
      done.add(remaining[0].id);
      remaining = remaining.filter((t) => t.id !== remaining[0].id);
      continue;
    }

    waves.push(ready);
    for (const t of ready) done.add(t.id);
    remaining = remaining.filter((t) => !ready.includes(t));
  }

  return waves;
}

// ============ CRITICAL PATH ============
function criticalPath(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map();

  function longestTo(t) {
    if (memo.has(t.id)) return memo.get(t.id);
    const effort = CONFIG.effortWeights[t.effort] || 3;
    let best = effort;
    let path = [t.id];

    for (const depId of t.dependsOn) {
      const dep = byId.get(depId);
      if (!dep) continue;
      const sub = longestTo(dep);
      if (sub.weight + effort > best) {
        best = sub.weight + effort;
        path = [...sub.path, t.id];
      }
    }

    const result = { weight: best, path };
    memo.set(t.id, result);
    return result;
  }

  let best = { weight: 0, path: [] };
  for (const t of tasks) {
    const r = longestTo(t);
    if (r.weight > best.weight) best = r;
  }
  return best;
}

// ============ ESTIMATOR ============
function estimateEffort(tasks) {
  const byEffort = { low: 0, medium: 0, high: 0 };
  let weight = 0;

  for (const t of tasks) {
    byEffort[t.effort] = (byEffort[t.effort] || 0) + 1;
    weight += CONFIG.effortWeights[t.effort] || 3;
  }

  // Rough time estimates
  const hoursMap = { low: 0.5, medium: 2, high: 6 };
  const hours = tasks.reduce((sum, t) => sum + (hoursMap[t.effort] || 1), 0);

  return {
    byEffort,
    totalWeight: weight,
    estimatedHours: +hours.toFixed(1),
    estimatedDays: +(hours / 6).toFixed(1), // 6 working hrs/day
  };
}

// ============ RISK ANALYSIS ============
function analyzeRisk(tasks) {
  const dist = { low: 0, medium: 0, high: 0 };
  const risky = [];

  for (const t of tasks) {
    dist[t.risk] = (dist[t.risk] || 0) + 1;
    if (t.risk === 'high' || t.blocking) risky.push(t.id);
  }

  const score =
    (dist.high * 3 + dist.medium * 1) / Math.max(1, tasks.length);

  return {
    distribution: dist,
    riskyTasks: risky,
    score: +score.toFixed(2),          // 0 = safe, >1 = risky
    level: score > 0.7 ? 'high' : score > 0.3 ? 'medium' : 'low',
  };
}

// ============ FILTERS / SORT ============
function applyFilters(tasks, opts = {}) {
  let out = tasks;

  if (opts.phases?.length) {
    out = out.filter((t) => opts.phases.includes(t.phase));
  }
  if (opts.priorities?.length) {
    out = out.filter((t) => opts.priorities.includes(t.priority));
  }
  if (opts.tags?.length) {
    out = out.filter((t) => t.tags.some((tag) => opts.tags.includes(tag)));
  }
  if (opts.types?.length) {
    out = out.filter((t) => opts.types.includes(t.type));
  }
  if (opts.maxPriority) {
    const cutoff = CONFIG.priorityRank[opts.maxPriority];
    out = out.filter((t) => CONFIG.priorityRank[t.priority] <= cutoff);
  }

  return out;
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    // 1) Phase (stabilize first)
    const pd = phaseRank(a.phase) - phaseRank(b.phase);
    if (pd !== 0) return pd;

    // 2) Blocking first
    if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;

    // 3) Priority
    const pr = CONFIG.priorityRank[a.priority] - CONFIG.priorityRank[b.priority];
    if (pr !== 0) return pr;

    // 4) Effort (small first)
    const ew = { low: 0, medium: 1, high: 2 };
    return (ew[a.effort] || 1) - (ew[b.effort] || 1);
  });
}

// ============ DEDUPLICATION ============
function dedupe(tasks) {
  const seen = new Set();
  return tasks.filter((t) => {
    const key = `${t.type}::${t.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============ MAIN PLANNER ============
class PlannerAgent {
  constructor() {
    this.lastPlan = null;
    this.history = [];
  }

  /**
   * Generate a plan from a project analysis.
   *
   * @param {Object} opts
   * @param {Object} opts.report       - Pre-computed report (optional)
   * @param {boolean} opts.deep        - Pass through to selfAnalyzer
   * @param {boolean} opts.save        - Save scan to memory
   * @param {string[]} opts.phases     - Filter phases
   * @param {string[]} opts.priorities - Filter priorities
   * @param {string[]} opts.tags       - Filter tags
   * @param {string} opts.maxPriority  - Max priority to include (critical|high|medium|low)
   * @param {number} opts.limit        - Max tasks returned
   * @param {boolean} opts.explain     - Include reasoning
   * @param {boolean} opts.waves       - Include parallel execution waves
   */
  async plan(opts = {}) {
    const t0 = Date.now();

    // 1) Analyze
    const report = opts.report || selfAnalyzer.analyze({
      deep: opts.deep !== false,
    });

    if (opts.save !== false && !opts.report) {
      try { await memoryManager.addProjectScan(report); } catch {}
    }

    // 2) Collect candidate tasks
    let candidates = [
      ...fromSecurity(report),
      ...fromMissingSkills(report),
      ...fromQuality(report),
      ...fromArchitecture(report),
      ...fromOrphans(report),
      ...fromPerformance(report),
    ];

    // 3) Dedupe & cap
    candidates = dedupe(candidates).slice(0, CONFIG.maxTasks);

    // 4) Resolve dependency links (type → id)
    candidates = resolveDependencies(candidates);

    // 5) Cycle check
    const cycles = detectCycles(candidates);

    // 6) Ordering & phases
    const sorted = sortTasks(candidates);
    const topo = topoSort(sorted);

    // 7) Waves (parallel groups)
    const waves = CONFIG.autoGroupParallel ? computeWaves(topo) : [];

    // 8) Critical path
    const cp = criticalPath(topo);

    // 9) Effort & risk
    const effort = estimateEffort(topo);
    const risk = analyzeRisk(topo);

    // 10) Filters
    let filtered = applyFilters(topo, {
      phases: opts.phases,
      priorities: opts.priorities,
      tags: opts.tags,
      types: opts.types,
      maxPriority: opts.maxPriority,
    });

    if (opts.limit) filtered = filtered.slice(0, opts.limit);

    // 11) Group by phase
    const byPhase = {};
    for (const t of filtered) {
      if (!byPhase[t.phase]) byPhase[t.phase] = [];
      byPhase[t.phase].push(t);
    }

    // 12) Summary
    const summary = {
      byPhase: Object.fromEntries(
        Object.entries(byPhase).map(([p, arr]) => [p, arr.length])
      ),
      byPriority: groupCount(filtered, 'priority'),
      byEffort: groupCount(filtered, 'effort'),
      byType: groupCount(filtered, 'type'),
    };

    // 13) Build final plan
    const plan = {
      planId: uid('plan'),
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,

      source: {
        reportGeneratedAt: report.generatedAt,
        score: report.score,
        totalFiles: report.overview?.totalFiles,
      },

      summary: {
        total: filtered.length,
        ...summary,
      },

      effort,
      risk,
      criticalPath: cp,
      cycles: cycles.map((c) => c.map((id) => topo.find((t) => t.id === id)?.type || id)),

      phases: Object.keys(byPhase).sort((a, b) => phaseRank(a) - phaseRank(b)),
      tasks: filtered,

      ...(opts.waves && {
        waves: waves.map((w, i) => ({
          wave: i + 1,
          parallel: w.length,
          tasks: w.map((t) => ({ id: t.id, type: t.type, title: t.title })),
        })),
      }),

      ...(opts.explain && {
        reasoning: {
          securityFirst: 'Critical security tasks are marked blocking and run first.',
          testsBeforeRefactor: 'Refactors depend on test coverage.',
          phases: PHASE_ORDER,
        },
      }),
    };

    // 14) Store
    this.lastPlan = plan;
    this.history.push({
      planId: plan.planId,
      time: plan.generatedAt,
      total: plan.summary.total,
      risk: plan.risk.level,
      effort: plan.effort.totalWeight,
    });
    if (this.history.length > 50) this.history = this.history.slice(-50);

    return plan;
  }

  // ---------- CONVENIENCE HELPERS ----------
  getNextTask(plan) {
    return plan?.tasks?.[0] || null;
  }

  getTasksByPhase(plan, phase) {
    return (plan?.tasks || []).filter((t) => t.phase === phase);
  }

  getBlockingTasks(plan) {
    return (plan?.tasks || []).filter((t) => t.blocking);
  }

  getCriticalPathTasks(plan) {
    if (!plan?.criticalPath?.path) return [];
    const ids = new Set(plan.criticalPath.path);
    return plan.tasks.filter((t) => ids.has(t.id));
  }

  // ---------- EXECUTE (via TaskAgent) ----------
  async executePlan(plan, taskAgent, opts = {}) {
    if (!taskAgent) throw new Error('taskAgent required');

    const results = [];
    const done = new Set();

    // Waves parallel execution
    const waves = computeWaves(plan.tasks);

    for (let i = 0; i < waves.length; i++) {
      const wave = waves[i];

      const waveResults = await Promise.all(
        wave.map(async (t) => {
          const cmd = this.taskToCommand(t);
          try {
            const res = await taskAgent.execute(cmd, opts);
            done.add(t.id);
            return { taskId: t.id, type: t.type, ok: res.ok, result: res };
          } catch (err) {
            return { taskId: t.id, type: t.type, ok: false, error: err.message };
          }
        })
      );

      results.push({ wave: i + 1, tasks: waveResults });

      if (opts.stopOnError && waveResults.some((r) => !r.ok)) {
        break;
      }
    }

    return {
      planId: plan.planId,
      executedAt: new Date().toISOString(),
      waves: results,
      completed: done.size,
      total: plan.tasks.length,
    };
  }

  taskToCommand(t) {
    switch (t.type) {
      case 'create-skill':    return `add skill ${t.target}`;
      case 'security-fix':    return `fix security bug priority=${t.priority}`;
      case 'quality-improvement': return `fix ${t.reason}`;
      case 'add-tests':       return `add tests`;
      case 'add-linter':      return `add linter`;
      case 'add-docs':        return `add documentation`;
      case 'cleanup-orphans': return `cleanup orphans`;
      case 'refactor':        return `refactor project`;
      case 'performance':     return `optimize performance`;
      default:                return `${t.type} target=${t.target || ''}`;
    }
  }

  // ---------- HISTORY ----------
  getHistory(limit = 10) {
    return this.history.slice(-limit).reverse();
  }

  // ---------- COMPARE PLANS ----------
  comparePlans(oldPlan, newPlan) {
    const oldIds = new Set(oldPlan.tasks.map((t) => t.type + ':' + t.title));
    const newIds = new Set(newPlan.tasks.map((t) => t.type + ':' + t.title));

    const added = newPlan.tasks.filter((t) => !oldIds.has(t.type + ':' + t.title));
    const removed = oldPlan.tasks.filter((t) => !newIds.has(t.type + ':' + t.title));
    const unchanged = newPlan.tasks.filter((t) => oldIds.has(t.type + ':' + t.title));

    return {
      added, removed, unchanged,
      delta: {
        total: newPlan.tasks.length - oldPlan.tasks.length,
        effort: newPlan.effort.totalWeight - oldPlan.effort.totalWeight,
        risk: newPlan.risk.score - oldPlan.risk.score,
      },
    };
  }
}

// ============ HELPERS ============
function groupCount(arr, key) {
  const out = {};
  for (const item of arr) {
    const k = item[key];
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

module.exports = new PlannerAgent();
