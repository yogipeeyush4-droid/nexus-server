// core/brain/codeAdvisor.js — Suggest Code Improvements (Human Approves)
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const llm = require('../llmGateway');
const knowledge = require('./knowledgeGraph');
const { LIMITS, checkLimit, isForbiddenPath, audit } = require('./safetyGuards');

const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'code_suggestions.json');

class CodeAdvisor {
  constructor() {
    this.suggestions = [];
    this.loaded = false;
  }

  load() {
    if (this.loaded) return;
    try {
      if (fs.existsSync(DATA_PATH)) {
        const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
        this.suggestions = raw.suggestions || [];
      }
    } catch (e) { console.error('[CodeAdvisor] load failed:', e.message); }
    this.loaded = true;
  }

  save() {
    try {
      const dir = path.dirname(DATA_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DATA_PATH, JSON.stringify({
        savedAt: new Date().toISOString(),
        suggestions: this.suggestions,
      }, null, 2));
    } catch (e) { console.error('[CodeAdvisor] save failed:', e.message); }
  }

  _pending() {
    return this.suggestions.filter(s => s.status === 'pending');
  }

  // 🔍 Specific file ke liye suggestion maango
  async suggestFor(filePath, concern = '') {
    this.load();

    // 🛡️ Forbidden check
    if (isForbiddenPath(filePath)) {
      return { ok: false, error: `File is protected: ${filePath}` };
    }

    const limit = checkLimit('maxCodeSuggestionsPending', this._pending().length);
    if (!limit.ok) return { ok: false, error: limit.error || limit.reason };

    if (!fs.existsSync(filePath)) return { ok: false, error: 'file not found' };

    const stat = fs.statSync(filePath);
    const maxKB = LIMITS.maxMemoryFileKB;
    if (stat.size > maxKB * 1024) return { ok: false, error: `file too big (> ${maxKB}KB)` };

    const content = fs.readFileSync(filePath, 'utf8');

    const prompt = `You are a senior code reviewer. Analyze this file and suggest SAFE improvements.

File: ${path.basename(filePath)}
Concern: ${concern || 'general improvement'}

Code:
\`\`\`
${content.slice(0, 6000)}
\`\`\`

Reply ONLY valid JSON:
{
  "issues": [{"line": 1, "severity": "high|med|low", "issue": "...", "fix": "..."}],
  "refactorIdeas": ["..."],
  "securityConcerns": ["..."],
  "confidence": 0.0
}`;

    try {
      const raw = await llm.ask(prompt, {
        system: 'Reply ONLY with valid JSON. Be conservative — only suggest changes you are sure about.',
        temperature: 0.2,
        maxTokens: 800,
      });

      let parsed = null;
      try { parsed = JSON.parse(raw); } catch {
        const m = String(raw).match(/\{[\s\S]*\}/);
        if (m) try { parsed = JSON.parse(m[0]); } catch {}
      }
      if (!parsed) return { ok: false, error: 'AI did not return valid JSON' };

      const suggestion = {
        id: crypto.randomBytes(6).toString('hex'),
        file: filePath,
        concern,
        issues: parsed.issues || [],
        refactorIdeas: parsed.refactorIdeas || [],
        securityConcerns: parsed.securityConcerns || [],
        confidence: parsed.confidence || 0,
        status: 'pending',      // pending → approved → applied / rejected
        created: Date.now(),
      };

      this.suggestions.push(suggestion);
      this.save();
      audit('code_suggestion_created', { id: suggestion.id, file: filePath });
      return { ok: true, suggestion };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 🔍 Self-scan — apne core files pe suggestion maango
  async selfScan(files = []) {
    const results = [];
    for (const f of files) {
      const r = await this.suggestFor(f, 'self-improvement');
      results.push({ file: f, ...r });
    }
    return results;
  }

  list(status = 'pending') {
    this.load();
    return status === 'all'
      ? this.suggestions
      : this.suggestions.filter(s => s.status === status);
  }

  // ✅ Tum approve karo
  approve(id, note = '') {
    this.load();
    const s = this.suggestions.find(x => x.id === id);
    if (!s) return { ok: false, error: 'not found' };
    s.status = 'approved';
    s.approvedAt = Date.now();
    s.approveNote = note;
    this.save();
    audit('code_suggestion_approved', { id });
    return { ok: true, suggestion: s };
  }

  // ❌ Tum reject karo
  reject(id, reason = '') {
    this.load();
    const s = this.suggestions.find(x => x.id === id);
    if (!s) return { ok: false, error: 'not found' };
    s.status = 'rejected';
    s.rejectedAt = Date.now();
    s.rejectReason = reason;
    this.save();
    audit('code_suggestion_rejected', { id, reason });

    // Lesson: AI yaad rakhega
    knowledge.addNode({
      type: 'rejected_suggestion',
      content: `Rejected on ${path.basename(s.file)}: ${reason || 'no reason'}`,
      tags: ['code-review', 'rejected'],
    });
    return { ok: true, suggestion: s };
  }

  // 📊 Stats
  stats() {
    this.load();
    const byStatus = {};
    for (const s of this.suggestions) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    return {
      total: this.suggestions.length,
      byStatus,
      maxPending: LIMITS.maxCodeSuggestionsPending,
    };
  }
}

module.exports = new CodeAdvisor();

