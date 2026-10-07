const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const plannerAgent = require('./plannerAgent');
const taskAgent = require('./TaskAgent');
const memoryManager = require('../core/memoryManager');

// ============ CONFIG ============
const CONFIG = {
  roadmapFile: process.env.EVOLUTION_FILE ||
    path.join(process.cwd(), '.evolution', 'roadmap.json'),
  checkpointDir: process.env.EVOLUTION_CHECKPOINT_DIR ||
    path.join(process.cwd(), '.evolution', 'checkpoints'),
  maxRoadmaps: 20,
  maxCheckpoints: 15,
  defaultStageSize: 3,           // tasks per stage
  minTasksForRoadmap: 1,
  enableAutoRun: false,          // safety default
  requireApproval: true,
  logLevel: process.env.LOG_LEVEL || 'info',
};

// ============ LOGGER ============
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LOG_LEVELS[CONFIG.logLevel] || 2;

function log(level, msg, meta) {
  if (LOG_LEVELS[level] > CURRENT_LEVEL) return;
  const prefix = `[EvolutionAgent]`;
  const line = meta
    ? `${prefix} ${level.toUpperCase()} ${msg} ${JSON.stringify(meta)}`
    : `${prefix} ${level.toUpperCase()} ${msg}`;
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

// ============ VERSIONING ============
const EVOLUTION_SCHEMA = 1;

// ============ STAGE TEMPLATES ============
const STAGE_TEMPLATES = {
  stabilize: {
    title: '🛡️ Stabilize',
    description: 'Fix critical issues before adding features',
    gate: 'no_critical_findings',
    color: 'red',
  },
  capability: {
    title: '🧩 Build Capabilities',
    description: 'Add missing skills & modules',
    gate: 'min_skills_coverage',
    color: 'orange',
  },
  improve: {
    title: '📈 Improve Quality',
    description: 'Tests, linting, refactoring',
    gate: 'quality_score_threshold',
    color: 'yellow',
  },
  optimize: {
    title: '⚡ Optimize',
    description: 'Performance, cleanup, dead code',
    gate: null,
    color: 'green',
  },
  devops: {
    title: '🚀 DevOps',
    description: 'CI/CD, containers, deployment',
    gate: null,
    color: 'blue',
  },
  polish: {
    title: '✨ Polish',
    description: 'Docs, README, licensing',
    gate: null,
    color: 'purple',
  },
};

// ============ UTILS ============
function uid(p = 'evo') {
  return `${p}_${crypto.randomBytes(5).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function atomicWrite(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, data, 'utf8');
  await fsp.rename(tmp, file);
}

// ============ IN-MEMORY STORE ============
let state = {
  schemaVersion: EVOLUTION_SCHEMA,
  roadmaps: [],           // history of generated roadmaps
  activeRoadmap: null,    // currently running roadmap
  milestones: [],         // completed milestones
  stats: {
    totalRoadmaps: 0,
    totalStagesCompleted: 0,
    totalTasksCompleted: 0,
    totalTasksFailed: 0,
    successfulEvolutions: 0,
  },
  createdAt: nowIso(),
  updatedAt: nowIso(),
};

// ============ PERSISTENCE ============
async function loadState() {
  try {
    const raw = await fsp.readFile(CONFIG.roadmapFile, 'utf8');
    const parsed = JSON.parse(raw);
    state = { ...state, ...parsed };
    log('debug', 'state loaded');
  } catch (err) {
    if (err.code !== 'ENOENT') log('warn', 'state load failed', { err: err.message });
  }
  return state;
}

async function saveState() {
  state.updatedAt = nowIso();
  state.roadmaps = state.roadmaps.slice(-CONFIG.maxRoadmaps);
  await atomicWrite(CONFIG.roadmapFile, JSON.stringify(state, null, 2));
  return state;
}

// ============ TASK → ROADMAP ITEM ============
function taskToRoadmapItem(task) {
  const item = {
    id: task.id || uid('item'),
    taskId: task.id,
    type: task.type,
    title: task.title,
    priority: task.priority,
    phase: task.phase,
    effort: task.effort,
    risk: task.risk,
    tags: task.tags || [],
    dependsOn: task.dependsOn || [],
    deliverables: task.deliverables || [],
    blocking: task.blocking || false,
    status: 'pending',   // pending | in_progress | done | failed | skipped
    startedAt: null,
    completedAt: null,
    durationMs: null,
    attempts: 0,
    result: null,
    error: null,
  };

  // Human-readable action
  switch (task.type) {
    case 'create-skill':
      item.action = `Create skill: ${task.target}`;
      item.command = `add skill ${task.target}`;
      break;
    case 'security-fix':
      item.action = `Fix ${task.count || 'critical'} security issue(s)`;
      item.command = `fix security priority=${task.priority}`;
      break;
    case 'quality-improvement':
      item.action = `Improve: ${task.reason || task.title}`;
      item.command = `improve quality`;
      break;
    case 'add-tests':
      item.action = `Add test coverage`;
      item.command = `add tests`;
      break;
    case 'add-linter':
      item.action = `Setup linter`;
      item.command = `add linter`;
      break;
    case 'add-docs':
      item.action = `Write documentation`;
      item.command = `add documentation`;
      break;
    case 'cleanup-orphans':
      item.action = `Clean ${task.metadata?.files?.length || 'unused'} file(s)`;
      item.command = `cleanup orphans`;
      break;
    case 'refactor':
      item.action = `Refactor: ${task.title}`;
      item.command = `refactor`;
      break;
    case 'performance':
      item.action = `Optimize: ${task.title}`;
      item.command = `optimize performance`;
      break;
    case 'add-ci':
      item.action = `Setup CI/CD pipeline`;
      item.command = `add ci`;
      break;
    default:
      item.action = task.title || task.type;
      item.command = task.type;
  }

  return item;
}

// ============ STAGE BUILDER ============
function buildStages(items) {
  // Group by phase (already ordered from planner)
  const byPhase = new Map();

  for (const item of items) {
    const phase = item.phase || 'improvement';
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase).push(item);
  }

  const phaseOrder = ['stabilize', 'capability', 'improve', 'optimize', 'devops', 'polish', 'improvement'];
  const stages = [];

  for (const phase of phaseOrder) {
    if (!byPhase.has(phase)) continue;

    const phaseItems = byPhase.get(phase);
    const template = STAGE_TEMPLATES[phase] || {};

    // Split large phases into sub-stages
    const chunks = chunkArray(phaseItems, CONFIG.defaultStageSize);

    chunks.forEach((chunk, i) => {
      stages.push({
        id: uid('stage'),
        phase,
        title: chunks.length > 1
          ? `${template.title || phase} (${i + 1}/${chunks.length})`
          : (template.title || phase),
        description: template.description || '',
        color: template.color,
        gate: template.gate,
        status: 'pending',     // pending | in_progress | done | blocked | failed
        itemIds: chunk.map((it) => it.id),
        startedAt: null,
        completedAt: null,
        durationMs: null,
        dependsOn: stages.length > 0 ? [stages[stages.length - 1].id] : [],
      });
    });
  }

  return stages;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ============ TIMELINE ESTIMATOR ============
function estimateTimeline(stages, items) {
  const hoursMap = { low: 0.5, medium: 2, high: 6 };

  const stageTimings = stages.map((stage) => {
    const stageItems = items.filter((i) => stage.itemIds.includes(i.id));
    const hours = stageItems.reduce((sum, t) => sum + (hoursMap[t.effort] || 1), 0);

    // Blocking/risky tasks take longer
    const riskMultiplier = stageItems.some((i) => i.risk === 'high') ? 1.4 : 1;
    const blockingMultiplier = stageItems.some((i) => i.blocking) ? 1.2 : 1;

    const adjusted = hours * riskMultiplier * blockingMultiplier;

    return {
      stageId: stage.id,
      title: stage.title,
      hours: +adjusted.toFixed(1),
      days: +(adjusted / 6).toFixed(1),     // 6 hrs work/day
    };
  });

  const totalHours = stageTimings.reduce((s, t) => s + t.hours, 0);

  return {
    perStage: stageTimings,
    totalHours: +totalHours.toFixed(1),
    totalDays: +(totalHours / 6).toFixed(1),
    totalWeeks: +(totalHours / 30).toFixed(2),
  };
}

// ============ MILESTONES ============
function buildMilestones(stages) {
  const milestones = [];

  for (const stage of stages) {
    if (!stage.gate) continue;

    milestones.push({
      id: uid('milestone'),
      stageId: stage.id,
      name: `Complete: ${stage.title}`,
      gate: stage.gate,
      status: 'pending',
      achievedAt: null,
    });
  }

  return milestones;
}

// ============ ROADMAP SUMMARY ============
function buildSummary(plan, stages, items) {
  const byStatus = {};
  const byPriority = {};
  const byPhase = {};

  for (const it of items) {
    byStatus[it.status] = (byStatus[it.status] || 0) + 1;
    byPriority[it.priority] = (byPriority[it.priority] || 0) + 1;
    byPhase[it.phase] = (byPhase[it.phase] || 0) + 1;
  }

  return {
    totalItems: items.length,
    totalStages: stages.length,
    totalMilestones: stages.filter((s) => s.gate).length,
    byStatus,
    byPriority,
    byPhase,
    planScore: plan.source?.score ?? null,
    planRisk: plan.risk?.level ?? null,
  };
}

// ============ EVENT EMITTER ============
class EvolutionAgent extends EventEmitter {
  constructor() {
    super();
    this.state = state;
    this._ready = null;
  }

  async _ensureLoaded() {
    if (!this._ready) this._ready = loadState();
    return this._ready;
  }

  // ---------- GENERATE ROADMAP ----------
  async evolve(opts = {}) {
    await this._ensureLoaded();
    const t0 = Date.now();

    // 1) Get plan (or use provided)
    const plan = opts.plan || await plannerAgent.plan({
      waves: opts.waves,
      explain: opts.explain,
      maxPriority: opts.maxPriority,
      phases: opts.phases,
      limit: opts.limit,
    });

    if (!plan.tasks?.length) {
      const empty = {
        ok: true,
        evolutionReady: false,
        reason: 'No tasks in plan — nothing to evolve',
        roadmap: [],
        stages: [],
        milestones: [],
        summary: { totalItems: 0, totalStages: 0, totalMilestones: 0 },
        generatedAt: nowIso(),
      };
      return empty;
    }

    // 2) Convert tasks → roadmap items
    const items = plan.tasks.map(taskToRoadmapItem);

    // 3) Group into stages by phase
    const stages = buildStages(items);

    // 4) Estimate timeline
    const timeline = estimateTimeline(stages, items);

    // 5) Milestones
    const milestones = buildMilestones(stages);

    // 6) Summary
    const summary = buildSummary(plan, stages, items);

    // 7) Build roadmap object
    const roadmap = {
      id: uid('roadmap'),
      version: EVOLUTION_SCHEMA,
      generatedAt: nowIso(),
      durationMs: Date.now() - t0,

      planId: plan.planId,
      source: {
        score: plan.source?.score,
        riskLevel: plan.risk?.level,
        totalPlanTasks: plan.tasks.length,
      },

      // Legacy flat list (backward compat)
      roadmap: items.map((i) => i.action),
      items,

      stages,
      milestones,
      timeline,
      summary,

      status: 'ready',       // ready | running | paused | done | failed
      currentStageIndex: 0,

      // Metadata
      approvals: opts.requireApproval ?? CONFIG.requireApproval,
      approved: !(opts.requireApproval ?? CONFIG.requireApproval),
    };

    // 8) Save
    state.roadmaps.push({
      id: roadmap.id,
      generatedAt: roadmap.generatedAt,
      itemCount: items.length,
      stageCount: stages.length,
      summary,
    });
    state.stats.totalRoadmaps++;
    state.activeRoadmap = roadmap;

    await saveState();

    log('info', 'roadmap generated', {
      id: roadmap.id,
      items: items.length,
      stages: stages.length,
      days: timeline.totalDays,
    });

    this.emit('roadmap:generated', roadmap);

    return {
      ok: true,
      evolutionReady: items.length >= CONFIG.minTasksForRoadmap,
      roadmapId: roadmap.id,
      roadmap: roadmap.roadmap,     // legacy
      items,
      stages,
      milestones,
      timeline,
      summary,
      planId: plan.planId,
      status: roadmap.status,
      generatedAt: roadmap.generatedAt,
    };
  }

  // ---------- APPROVE ----------
  async approve(roadmapId) {
    await this._ensureLoaded();
    const rm = state.roadmaps.find((r) => r.id === roadmapId) ||
      (state.activeRoadmap?.id === roadmapId ? state.activeRoadmap : null);

    if (!rm) throw new Error('Roadmap not found');

    if (state.activeRoadmap?.id === roadmapId) {
      state.activeRoadmap.approved = true;
      state.activeRoadmap.status = 'ready';
    }
    await saveState();

    this.emit('roadmap:approved', { roadmapId });
    return { ok: true, roadmapId, approved: true };
  }

  // ---------- EXECUTE ----------
  async execute(roadmapId = null, opts = {}) {
    await this._ensureLoaded();

    const roadmap = roadmapId
      ? state.roadmaps.find((r) => r.id === roadmapId) || state.activeRoadmap
      : state.activeRoadmap;

    if (!roadmap) throw new Error('No active roadmap');
    if (roadmap.approvals && !roadmap.approved && !opts.force) {
      return { ok: false, error: 'Roadmap not approved', roadmapId: roadmap.id };
    }

    if (roadmap.status === 'running') {
      return { ok: false, error: 'Already running', roadmapId: roadmap.id };
    }

    roadmap.status = 'running';
    this.emit('evolution:start', { roadmapId: roadmap.id });
    const t0 = Date.now();

    const results = [];
    const stopOnError = opts.stopOnError ?? false;
    const dryRun = opts.dryRun ?? false;

    for (let si = 0; si < roadmap.stages.length; si++) {
      const stage = roadmap.stages[si];

      // Dependency gate
      if (stage.dependsOn?.length) {
        const blockedBy = stage.dependsOn.find((depId) => {
          const dep = roadmap.stages.find((s) => s.id === depId);
          return dep && dep.status !== 'done';
        });
        if (blockedBy) {
          stage.status = 'blocked';
          log('warn', 'stage blocked', { stageId: stage.id });
          break;
        }
      }

      stage.status = 'in_progress';
      stage.startedAt = nowIso();
      roadmap.currentStageIndex = si;
      this.emit('stage:start', { stageId: stage.id, title: stage.title });

      const stageStart = Date.now();
      const stageResults = [];

      for (const itemId of stage.itemIds) {
        const item = roadmap.items.find((i) => i.id === itemId);
        if (!item || item.status === 'done') continue;

        item.status = 'in_progress';
        item.startedAt = nowIso();
        item.attempts++;
        this.emit('item:start', { itemId: item.id, action: item.action });

        if (dryRun) {
          item.status = 'skipped';
          item.result = { dryRun: true };
          stageResults.push({ itemId: item.id, ok: true, dryRun: true });
          continue;
        }

        try {
          const res = await taskAgent.execute(item.command, {
            save: opts.save,
            user: opts.user,
          });

          if (res.ok) {
            item.status = 'done';
            item.completedAt = nowIso();
            item.durationMs = Date.now() - new Date(item.startedAt).getTime();
            item.result = res;
            state.stats.totalTasksCompleted++;
            this.emit('item:done', { itemId: item.id, durationMs: item.durationMs });
          } else {
            item.status = 'failed';
            item.error = res.error || 'unknown';
            state.stats.totalTasksFailed++;
            this.emit('item:error', { itemId: item.id, error: item.error });

            if (stopOnError) {
              stage.status = 'failed';
              roadmap.status = 'failed';
              await saveState();
              return { ok: false, roadmapId: roadmap.id, failedItem: item };
            }
          }
          stageResults.push({ itemId: item.id, ok: res.ok, result: res });

        } catch (err) {
          item.status = 'failed';
          item.error = err.message;
          state.stats.totalTasksFailed++;
          this.emit('item:error', { itemId: item.id, error: err.message });
          stageResults.push({ itemId: item.id, ok: false, error: err.message });

          if (stopOnError) {
            stage.status = 'failed';
            roadmap.status = 'failed';
            await saveState();
            return { ok: false, roadmapId: roadmap.id, failedItem: item };
          }
        }
      }

      // Stage done?
      const stageItems = roadmap.items.filter((i) => stage.itemIds.includes(i.id));
      const allDone = stageItems.every((i) => i.status === 'done' || i.status === 'skipped');

      stage.status = allDone ? 'done' : 'failed';
      stage.completedAt = nowIso();
      stage.durationMs = Date.now() - stageStart;

      if (stage.status === 'done') {
        state.stats.totalStagesCompleted++;

        // Milestone?
        const ms = roadmap.milestones?.find((m) => m.stageId === stage.id);
        if (ms) {
          ms.status = 'achieved';
          ms.achievedAt = nowIso();
          this.emit('milestone:achieved', ms);
        }
      }

      this.emit('stage:done', { stageId: stage.id, status: stage.status, durationMs: stage.durationMs });

      results.push({ stageId: stage.id, title: stage.title, status: stage.status, tasks: stageResults });

      await saveState();    // save after every stage
    }

    // Final status
    const allStagesDone = roadmap.stages.every((s) => s.status === 'done');
    roadmap.status = allStagesDone ? 'done' : 'failed';
    roadmap.completedAt = nowIso();

    if (roadmap.status === 'done') {
      state.stats.successfulEvolutions++;

      // Record in memory manager as a scan milestone
      try {
        await memoryManager.addProjectScan({
          score: roadmap.source?.score || 0,
          skills: { detectedCount: 0, missingCount: 0 },
          overview: { totalFiles: 0, totalSize: '0 B' },
        });
      } catch {}
    }

    await saveState();

    const totalMs = Date.now() - t0;
    this.emit('evolution:done', { roadmapId: roadmap.id, status: roadmap.status, totalMs });

    return {
      ok: allStagesDone,
      roadmapId: roadmap.id,
      status: roadmap.status,
      totalMs,
      stages: results,
      summary: roadmap.summary,
    };
  }

  // ---------- ROLLBACK ----------
  async rollback(roadmapId = null) {
    await this._ensureLoaded();
    const rm = roadmapId
      ? state.roadmaps.find((r) => r.id === roadmapId)
      : state.activeRoadmap;
    if (!rm) throw new Error('Roadmap not found');

    // Reset pending items only (don't undo done tasks — dangerous)
    for (const item of rm.items) {
      if (item.status === 'in_progress' || item.status === 'failed') {
        item.status = 'pending';
        item.startedAt = null;
        item.error = null;
      }
    }
    for (const stage of rm.stages) {
      if (stage.status === 'failed' || stage.status === 'in_progress') {
        stage.status = 'pending';
      }
    }
    rm.status = 'ready';
    await saveState();

    this.emit('evolution:rollback', { roadmapId: rm.id });
    return { ok: true, roadmapId: rm.id, status: 'ready' };
  }

  // ---------- CHECKPOINT ----------
  async checkpoint(roadmapId = null) {
    await this._ensureLoaded();
    const rm = roadmapId
      ? state.roadmaps.find((r) => r.id === roadmapId)
      : state.activeRoadmap;
    if (!rm) throw new Error('Roadmap not found');

    await ensureDir(CONFIG.checkpointDir);
    const file = path.join(CONFIG.checkpointDir, `${rm.id}-${Date.now()}.json`);

    await atomicWrite(file, JSON.stringify(rm, null, 2));

    // Rotate
    const files = (await fsp.readdir(CONFIG.checkpointDir))
      .filter((f) => f.endsWith('.json'))
      .sort();

    if (files.length > CONFIG.maxCheckpoints) {
      for (const f of files.slice(0, files.length - CONFIG.maxCheckpoints)) {
        await fsp.unlink(path.join(CONFIG.checkpointDir, f)).catch(() => {});
      }
    }

    return { ok: true, checkpoint: file };
  }

  async restoreCheckpoint(checkpointFile) {
    await this._ensureLoaded();
    const raw = await fsp.readFile(checkpointFile, 'utf8');
    const rm = JSON.parse(raw);
    state.activeRoadmap = rm;
    await saveState();
    return { ok: true, roadmapId: rm.id };
  }

  // ---------- PROGRESS ----------
  async getProgress(roadmapId = null) {
    await this._ensureLoaded();
    const rm = roadmapId
      ? state.roadmaps.find((r) => r.id === roadmapId)
      : state.activeRoadmap;
    if (!rm) return { ok: false, error: 'No roadmap' };

    const total = rm.items.length;
    const done = rm.items.filter((i) => i.status === 'done').length;
    const failed = rm.items.filter((i) => i.status === 'failed').length;
    const skipped = rm.items.filter((i) => i.status === 'skipped').length;
    const pending = total - done - failed - skipped;

    const stagesDone = rm.stages.filter((s) => s.status === 'done').length;

    return {
      ok: true,
      roadmapId: rm.id,
      status: rm.status,
      percent: total > 0 ? +((done / total) * 100).toFixed(1) : 0,
      counts: { total, done, failed, skipped, pending },
      stages: {
        total: rm.stages.length,
        done: stagesDone,
        current: rm.stages.find((s) => s.status === 'in_progress')?.title || null,
      },
      timeline: rm.timeline,
      milestones: (rm.milestones || []).map((m) => ({
        name: m.name,
        status: m.status,
        achievedAt: m.achievedAt,
      })),
    };
  }

  // ---------- HISTORY ----------
  async getHistory(limit = 10) {
    await this._ensureLoaded();
    return state.roadmaps.slice(-limit).reverse();
  }

  async getStats() {
    await this._ensureLoaded();
    return {
      ...state.stats,
      activeRoadmapId: state.activeRoadmap?.id || null,
      historySize: state.roadmaps.length,
      updatedAt: state.updatedAt,
    };
  }

  // ---------- EXPORT ----------
  async export(roadmapId = null, format = 'json') {
    await this._ensureLoaded();
    const rm = roadmapId
      ? state.roadmaps.find((r) => r.id === roadmapId)
      : state.activeRoadmap;
    if (!rm) throw new Error('No roadmap');

    if (format === 'json') return JSON.stringify(rm, null, 2);

    if (format === 'markdown' || format === 'md') {
      return roadmapToMarkdown(rm);
    }

    throw new Error(`Unknown format: ${format}`);
  }
}

// ============ MARKDOWN EXPORT ============
function roadmapToMarkdown(rm) {
  const lines = [];
  lines.push(`# 🧬 Evolution Roadmap — ${rm.id}`);
  lines.push('');
  lines.push(`**Generated:** ${rm.generatedAt}`);
  lines.push(`**Status:** \`${rm.status}\``);
  lines.push(`**Timeline:** ~${rm.timeline?.totalDays ?? '?'} days (${rm.timeline?.totalHours ?? '?'} hrs)`);
  lines.push('');

  lines.push(`## 📊 Summary`);
  lines.push('');
  lines.push(`- Total items: **${rm.items.length}**`);
  lines.push(`- Stages: **${rm.stages.length}**`);
  lines.push(`- Milestones: **${rm.milestones?.length ?? 0}**`);
  lines.push('');

  for (const stage of rm.stages) {
    lines.push(`## ${stage.title}`);
    lines.push(`> ${stage.description || ''}  `);
    lines.push(`**Status:** \`${stage.status}\``);
    lines.push('');

    const items = rm.items.filter((i) => stage.itemIds.includes(i.id));
    for (const it of items) {
      const cb = it.status === 'done' ? 'x' : ' ';
      lines.push(`- [${cb}] **${it.action}**  \n  _priority:_ ${it.priority} · _effort:_ ${it.effort} · _risk:_ ${it.risk}`);
    }
    lines.push('');
  }

  if (rm.milestones?.length) {
    lines.push(`## 🏁 Milestones`);
    for (const m of rm.milestones) {
      lines.push(`- [${m.status === 'achieved' ? 'x' : ' '}] ${m.name} (gate: \`${m.gate}\`)`);
    }
  }

  return lines.join('\n');
}

// ============ EXPORT ============
const evolutionAgent = new EvolutionAgent();
evolutionAgent.loadState = loadState;
evolutionAgent.saveState = saveState;
evolutionAgent.roadmapToMarkdown = roadmapToMarkdown;
evolutionAgent.CONFIG = CONFIG;

module.exports = evolutionAgent;

