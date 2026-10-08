
// core/brain/reflectionEngine.js — Learn From Every Action
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const llm = require('../llmGateway');
const knowledge = require('./knowledgeGraph');
const strategyEngine = require('./strategyEngine');
const { audit } = require('./safetyGuards');

const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'reflections.json');

class ReflectionEngine {
  constructor() {
    this.reflections = [];
    this.loaded = false;
  }

  load() {
    if (this.loaded) return;
    try {
      if (fs.existsSync(DATA_PATH)) {
        const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
        this.reflections = raw.reflections || [];
      }
    } catch (e) { console.error('[ReflectionEngine] load failed:', e.message); }
    this.loaded = true;
  }

  save() {
    try {
      const dir = path.dirname(DATA_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DATA_PATH, JSON.stringify({
        savedAt: new Date().toISOString(),
        reflections: this.reflections.slice(-500),   // last 500
      }, null, 2));
    } catch (e) { console.error('[ReflectionEngine] save failed:', e.message); }
  }

  // 🪞 Post-action reflection
  async reflect({ action, input, output, success, latencyMs, strategyName = null }) {
    this.load();

    const reflection = {
      id: crypto.randomBytes(6).toString('hex'),
      action,
      input: String(input).slice(0, 500),
      output: String(output).slice(0, 500),
      success,
      latencyMs,
      strategyName,
      ts: Date.now(),
      insights: [],
      lessons: [],
    };

    // 🧠 AI se reflection maango (sirf complex actions ke liye)
    if (action !== 'simple_chat' && input && String(input).length > 20) {
      try {
        const prompt = `Analyze this action and extract lessons.

Action: ${action}
Input: ${input}
Output: ${output}
Success: ${success}
Latency: ${latencyMs}ms

Reply ONLY valid JSON with this exact shape:
{
  "insights": ["insight 1", "insight 2"],
  "lessons": ["lesson 1", "lesson 2"],
  "wouldDoDifferently": "short note or empty string",
  "confidence": 0.0
}`;
        const raw = await llm.ask(prompt, {
          system: 'You are a self-improvement analyzer. Reply ONLY with valid JSON.',
          temperature: 0.3,
          maxTokens: 400,
        });

        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {
          const m = String(raw).match(/\{[\s\S]*\}/);
          if (m) try { parsed = JSON.parse(m[0]); } catch {}
        }

        if (parsed) {
          reflection.insights = (parsed.insights || []).slice(0, 5);
          reflection.lessons = (parsed.lessons || []).slice(0, 5);
          reflection.wouldDoDifferently = parsed.wouldDoDifferently || '';
          reflection.confidence = parsed.confidence || 0;
        }
      } catch (e) {
        // reflection fail ho to silently ignore
      }
    }

    // Knowledge mein save karo (important lessons)
    for (const lesson of reflection.lessons) {
      if (lesson.length > 10) {
        knowledge.addNode({
          type: 'lesson',
          content: lesson,
          tags: [action, success ? 'win' : 'loss'],
          weight: success ? 2 : 3,   // failures se zyada seekho
        });
      }
    }

    // Strategy performance record
    if (strategyName) {
      strategyEngine.record(strategyName, { success, latencyMs, note: reflection.wouldDoDifferently });
    }

    this.reflections.push(reflection);
    if (this.reflections.length > 500) this.reflections = this.reflections.slice(-500);
    this.save();
    audit('reflection', { id: reflection.id, action, success });

    return reflection;
  }

  // 📊 Overall performance summary
  summary(lastN = 50) {
    this.load();
    const recent = this.reflections.slice(-lastN);
    if (!recent.length) return { count: 0, successRate: 0, avgLatencyMs: 0, topLessons: [] };

    const wins = recent.filter(r => r.success).length;
    const avgLatency = Math.round(recent.reduce((a, r) => a + (r.latencyMs || 0), 0) / recent.length);

    // Top lessons — jo baar baar aaye
    const lessonCount = {};
    for (const r of recent) for (const l of r.lessons) lessonCount[l] = (lessonCount[l] || 0) + 1;
    const topLessons = Object.entries(lessonCount)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([text, count]) => ({ text, count }));

    return {
      count: recent.length,
      successRate: +(wins / recent.length).toFixed(3),
      avgLatencyMs: avgLatency,
      topLessons,
    };
  }

  // 🔍 Similar past situations
  findSimilar(input, limit = 3) {
    this.load();
    const q = String(input).toLowerCase();
    const words = q.split(/\s+/).filter(w => w.length > 3);

    return this.reflections
      .map(r => {
        const text = (r.input + ' ' + r.output).toLowerCase();
        const matches = words.filter(w => text.includes(w)).length;
        return { ...r, score: matches };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

module.exports = new ReflectionEngine();
