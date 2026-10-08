// core/brain/strategyEngine.js — Learn Which Approaches Work
'use strict';

const fs = require('fs');
const path = require('path');
const { LIMITS, checkLimit, audit } = require('./safetyGuards');

const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'strategies.json');

class StrategyEngine {
  constructor() {
    this.strategies = new Map();   // name -> { name, uses, wins, losses, avgLatency, lastUsed }
    this.loaded = false;
  }

  load() {
    if (this.loaded) return;
    try {
      if (fs.existsSync(DATA_PATH)) {
        const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
        for (const s of raw.strategies || []) this.strategies.set(s.name, s);
      }
    } catch (e) { console.error('[StrategyEngine] load failed:', e.message); }
    this.loaded = true;
  }

  save() {
    try {
      const dir = path.dirname(DATA_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DATA_PATH, JSON.stringify({
        savedAt: new Date().toISOString(),
        strategies: [...this.strategies.values()],
      }, null, 2));
    } catch (e) { console.error('[StrategyEngine] save failed:', e.message); }
  }

  register(name, meta = {}) {
    this.load();
    if (this.strategies.has(name)) return { ok: true, existing: true };

    const limit = checkLimit('maxStrategyVariants', this.strategies.size);
    if (!limit.ok) return { ok: false, error: limit.reason };

    this.strategies.set(name, {
      name,
      description: meta.description || '',
      category: meta.category || 'general',
      uses: 0,
      wins: 0,
      losses: 0,
      totalLatencyMs: 0,
      created: Date.now(),
      lastUsed: null,
      tags: meta.tags || [],
    });
    this.save();
    return { ok: true };
  }

  record(name, { success, latencyMs = 0, note = '' }) {
    this.load();
    const s = this.strategies.get(name);
    if (!s) return { ok: false, error: 'strategy not found' };

    s.uses++;
    if (success) s.wins++; else s.losses++;
    s.totalLatencyMs += latencyMs;
    s.lastUsed = Date.now();
    if (note) s.lastNote = String(note).slice(0, 300);

    audit('strategy_record', { name, success, latencyMs });
    this.save();
    return { ok: true, strategy: s };
  }

  // 📊 Win-rate based best strategy
  getWinRate(name) {
    this.load();
    const s = this.strategies.get(name);
    if (!s || s.uses === 0) return 0;
    return s.wins / s.uses;
  }

  // 🎯 Best strategy for a category
  pick(category, options = {}) {
    this.load();
    const { minUses = 3, exploration = 0.1 } = options;
    const candidates = [...this.strategies.values()]
      .filter(s => s.category === category);

    if (!candidates.length) return null;

    // Exploration — kabhi kabhi naya try karo (learning ke liye)
    if (Math.random() < exploration) {
      return candidates[Math.floor(Math.random() * candidates.length)].name;
    }

    // Exploitation — best win rate
    const tested = candidates.filter(s => s.uses >= minUses);
    const pool = tested.length ? tested : candidates;

    pool.sort((a, b) => {
      const wa = a.uses ? a.wins / a.uses : 0;
      const wb = b.uses ? b.wins / b.uses : 0;
      if (wa !== wb) return wb - wa;
      return a.totalLatencyMs / Math.max(1, a.uses) - b.totalLatencyMs / Math.max(1, b.uses);
    });

    return pool[0].name;
  }

  // 📈 Sab strategies ki ranking
  ranking(category = null) {
    this.load();
    let list = [...this.strategies.values()];
    if (category) list = list.filter(s => s.category === category);
    return list
      .map(s => ({
        name: s.name,
        category: s.category,
        uses: s.uses,
        winRate: s.uses ? +(s.wins / s.uses).toFixed(3) : 0,
        avgLatencyMs: s.uses ? Math.round(s.totalLatencyMs / s.uses) : 0,
      }))
      .sort((a, b) => b.winRate - a.winRate || b.uses - a.uses);
  }

  stats() {
    this.load();
    const all = [...this.strategies.values()];
    return {
      total: all.length,
      byCategory: all.reduce((acc, s) => {
        acc[s.category] = (acc[s.category] || 0) + 1; return acc;
      }, {}),
      maxAllowed: LIMITS.maxStrategyVariants,
    };
  }
}

module.exports = new StrategyEngine();

