// core/brain/goalEngine.js — Autonomous Goal Management
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LIMITS, checkLimit, audit } = require('./safetyGuards');

const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'goals.json');

class GoalEngine {
  constructor() {
    this.goals = new Map();
    this.addedToday = 0;
    this.lastDayReset = new Date().toDateString();
    this.loaded = false;
  }

  load() {
    if (this.loaded) return;
    try {
      if (fs.existsSync(DATA_PATH)) {
        const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
        for (const g of raw.goals || []) this.goals.set(g.id, g);
        this.addedToday = raw.addedToday || 0;
        this.lastDayReset = raw.lastDayReset || new Date().toDateString();
      }
    } catch (e) { console.error('[GoalEngine] load failed:', e.message); }
    this._resetDailyIfNeeded();
    this.loaded = true;
  }

  save() {
    try {
      const dir = path.dirname(DATA_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DATA_PATH, JSON.stringify({
        savedAt: new Date().toISOString(),
        addedToday: this.addedToday,
        lastDayReset: this.lastDayReset,
        goals: [...this.goals.values()],
      }, null, 2));
    } catch (e) { console.error('[GoalEngine] save failed:', e.message); }
  }

  _resetDailyIfNeeded() {
    const today = new Date().toDateString();
    if (this.lastDayReset !== today) {
      this.addedToday = 0;
      this.lastDayReset = today;
    }
  }

  _activeGoals() {
    return [...this.goals.values()].filter(g => g.status === 'active');
  }

  addGoal({ title, description = '', priority = 5, tags = [], source = 'self' }) {
    this.load();
    this._resetDailyIfNeeded();

    const activeLimit = checkLimit('maxGoalsActive', this._activeGoals().length);
    if (!activeLimit.ok) return { ok: false, error: activeLimit.reason };

    const dailyLimit = checkLimit('maxGoalsAddPerDay', this.addedToday);
    if (!dailyLimit.ok) return { ok: false, error: dailyLimit.reason };

    if (!title || String(title).length < 3) return { ok: false, error: 'title too short' };

    const id = crypto.randomBytes(6).toString('hex');
    const goal = {
      id,
      title: String(title).slice(0, 200),
      description: String(description).slice(0, 1000),
      priority: Math.max(1, Math.min(10, priority)),
      tags,
      source,
      status: 'active',
      progress: 0,
      attempts: 0,
      created: Date.now(),
      updated: Date.now(),
    };
    this.goals.set(id, goal);
    this.addedToday++;
    audit('goal_add', { id, title: goal.title, source });
    this.save();
    return { ok: true, goal };
  }

  updateProgress(id, progress, note = '') {
    this.load();
    const g = this.goals.get(id);
    if (!g) return { ok: false, error: 'goal not found' };

    g.progress = Math.max(0, Math.min(100, progress));
    g.updated = Date.now();
    g.attempts++;
    if (note) g.lastNote = String(note).slice(0, 500);

    if (g.progress >= 100) g.status = 'completed';
    this.save();
    return { ok: true, goal: g };
  }

  complete(id, outcome = 'success') {
    this.load();
    const g = this.goals.get(id);
    if (!g) return { ok: false, error: 'goal not found' };
    g.status = outcome === 'success' ? 'completed' : 'failed';
    g.progress = 100;
    g.completedAt = Date.now();
    g.updated = Date.now();
    this.save();
    audit('goal_complete', { id, outcome });
    return { ok: true, goal: g };
  }

  abandon(id, reason = '') {
    this.load();
    const g = this.goals.get(id);
    if (!g) return { ok: false, error: 'goal not found' };
    g.status = 'abandoned';
    g.abandonReason = reason;
    g.updated = Date.now();
    this.save();
    return { ok: true, goal: g };
  }

  // 🎯 Priority sorting — jo jaldi karna chahiye wo pehle
  prioritized(limit = 10) {
    this.load();
    return this._activeGoals()
      .sort((a, b) => {
        // Higher priority first
        if (a.priority !== b.priority) return b.priority - a.priority;
        // Older goals (higher age) → zyada urgency
        return a.created - b.created;
      })
      .slice(0, limit);
  }

  // 🔍 Empty/lonely goals dhundho — inhe AI khud khud resolve kare
  stale(olderThanMs = 7 * 24 * 60 * 60 * 1000) {
    this.load();
    const now = Date.now();
    return this._activeGoals().filter(g => now - g.updated > olderThanMs);
  }

  stats() {
    this.load();
    const all = [...this.goals.values()];
    const byStatus = {};
    for (const g of all) byStatus[g.status] = (byStatus[g.status] || 0) + 1;
    return {
      total: all.length,
      active: this._activeGoals().length,
      addedToday: this.addedToday,
      byStatus,
      limits: { maxActive: LIMITS.maxGoalsActive, maxPerDay: LIMITS.maxGoalsAddPerDay },
    };
  }
}

module.exports = new GoalEngine();

