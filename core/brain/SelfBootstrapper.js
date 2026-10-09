// core/brain/selfBootstrapper.js — self-learning module
'use strict';

class SelfBootstrapper {
  constructor({ llm, resolver, knowledge, logger, emitThought }) {
    this.llm = llm;
    this.resolver = resolver;
    this.knowledge = knowledge;
    this.logger = logger;
    this.emitThought = emitThought || (() => {});
    this.learningGraph = new Map();
  }

  async acquire(skill, ctx = {}) {
    this.emitThought({ stage: 'self_bootstrap_start', skill });

    const already = await this._checkExisting(skill);
    if (already.exists) {
      this.emitThought({ stage: 'self_bootstrap_skip', skill, reason: 'already known' });
      return { ok: true, alreadyKnown: true, capability: already.capability };
    }

    this.emitThought({ stage: 'curriculum_planning', skill });
    const curriculum = await this._planCurriculum(skill);
    if (!curriculum.length) {
      return { ok: false, error: 'Curriculum could not be planned.' };
    }
    this.learningGraph.set(skill, { subSkills: curriculum, mastered: [], failed: [] });

    const learned = [];
    for (const sub of curriculum) {
      this.emitThought({ stage: 'learning_sub_skill', skill, sub: sub.name });

      const spec = await this._generateSkillSpec(sub);
      if (!spec) {
        this.learningGraph.get(skill).failed.push(sub.name);
        continue;
      }

      const verified = await this._sandboxVerify(sub, spec);
      if (!verified.passed) {
        this.emitThought({ stage: 'sandbox_failed', skill, sub: sub.name, reason: verified.reason });
        this.learningGraph.get(skill).failed.push(sub.name);
        continue;
      }

      const capName = `skill_${this._slug(sub.name)}`;
      this.resolver.register({
        name: capName,
        matchGapTypes: ['capability', 'definition', 'verification'],
        weight: 1.5,
        handle: async (gap, ctx2) => {
          if (!this._matchesSkill(gap.subject, sub.name)) {
            return { ok: false, error: 'skill-mismatch' };
          }
          const answer = await this._applySkill(sub, spec, gap.subject, ctx2);
          if (!answer) return { ok: false, error: 'apply failed' };
          return {
            ok: true,
            items: [{
              content: answer,
              source: `learned:${capName}`,
              ts: Date.now(),
            }],
          };
        },
      });

      if (this.knowledge?.addNode) {
        try {
          await this.knowledge.addNode({
            type: 'learned_skill',
            content: `SKILL: ${sub.name}\nSPEC: ${JSON.stringify(spec).slice(0, 1500)}\nEXAMPLES: ${verified.examples?.slice(0, 3).join(' | ') || 'n/a'}`,
            tags: ['self_bootstrapped', 'skill', skill],
            metadata: {
              parentSkill: skill,
              subSkill: sub.name,
              capabilityName: capName,
              learnedAt: Date.now(),
              verifiedBy: verified.method,
            },
          });
        } catch (err) {
          this.logger?.warn?.('[Bootstrap] memory write failed', { err: err.message });
        }
      }

      this.learningGraph.get(skill).mastered.push(sub.name);
      learned.push({ sub: sub.name, capability: capName });
    }

    this.emitThought({
      stage: 'self_bootstrap_done',
      skill,
      mastered: learned.length,
      failed: this.learningGraph.get(skill).failed.length,
    });

    return {
      ok: learned.length > 0,
      skill,
      learned,
      curriculum,
      alreadyKnown: false,
    };
  }

  async _checkExisting(skill) {
    if (!this.knowledge?.search) return { exists: false };
    try {
      const hits = await this.knowledge.search(`SKILL: ${skill}`, 3);
      const strong = hits?.find(h =>
        String(h.content).toLowerCase().includes(skill.toLowerCase()) &&
        String(h.content).toLowerCase().includes('skill')
      );
      return strong ? { exists: true, capability: strong.metadata?.capabilityName } : { exists: false };
    } catch { return { exists: false }; }
  }

  async _planCurriculum(skill) {
    const prompt = `You are planning a LEARNING CURRICULUM for an AI brain.

TARGET SKILL: "${skill}"

Break this into 3-6 concrete, testable SUB-SKILLS. Each must be self-contained
and something the AI could execute OR reason about after learning.

Return ONLY valid JSON:
{
  "subSkills": [
    {"name":"...", "type":"computational|conceptual|procedural", "why":"one line"}
  ]
}`;
    try {
      const raw = await this.llm.ask(prompt, { temperature: 0.4, maxTokens: 600 });
      const m = String(raw).match(/\{[\s\S]*\}/);
      if (!m) return [];
      const p = JSON.parse(m[0]);
      return Array.isArray(p.subSkills) ? p.subSkills.slice(0, 6) : [];
    } catch { return []; }
  }

  async _generateSkillSpec(sub) {
    const prompt = `Create an EXECUTABLE SPEC for this AI sub-skill.

SUB-SKILL: "${sub.name}"
TYPE: ${sub.type}
PURPOSE: ${sub.why}

If "computational": return a formula/algorithm the AI can apply.
If "conceptual": return key rules + 3 checks the AI should apply.
If "procedural": return ordered steps.

Return ONLY valid JSON:
{
  "kind": "formula|rules|steps",
  "logic": "the actual spec (JS-safe string)",
  "examples": ["example input -> expected output"]
}`;
    try {
      const raw = await this.llm.ask(prompt, { temperature: 0.3, maxTokens: 800 });
      const m = String(raw).match(/\{[\s\S]*\}/);
      if (!m) return null;
      return JSON.parse(m[0]);
    } catch { return null; }
  }

  async _sandboxVerify(sub, spec) {
    const prompt = `Generate 3 test cases for this skill spec.

SKILL: ${sub.name}
SPEC: ${JSON.stringify(spec).slice(0, 600)}

Return ONLY valid JSON: {"tests":[{"input":"...","expected":"..."}]}`;
    let tests = [];
    try {
      const raw = await this.llm.ask(prompt, { temperature: 0.3, maxTokens: 400 });
      const m = String(raw).match(/\{[\s\S]*\}/);
      if (m) tests = JSON.parse(m[0]).tests || [];
    } catch {}

    if (!tests.length) {
      return { passed: false, reason: 'no test cases generated', method: 'sandbox' };
    }

    const verifyPrompt = `You are a VERIFIER. Given a spec and test cases, check if the spec
would produce correct answers.

SPEC: ${JSON.stringify(spec).slice(0, 800)}
TESTS: ${JSON.stringify(tests)}

Return ONLY valid JSON: {"passed":true,"correct":2,"total":3,"reason":"..."}`;

    try {
      const raw = await this.llm.ask(verifyPrompt, { temperature: 0.1, maxTokens: 300 });
      const m = String(raw).match(/\{[\s\S]*\}/);
      if (!m) return { passed: false, reason: 'verify failed', method: 'sandbox' };
      const result = JSON.parse(m[0]);
      return {
        passed: result.passed && result.correct >= Math.ceil(result.total * 0.66),
        reason: result.reason,
        examples: tests.map(t => `${t.input} → ${t.expected}`),
        method: 'sandbox',
      };
    } catch {
      return { passed: false, reason: 'exception', method: 'sandbox' };
    }
  }

  async _applySkill(sub, spec, question, ctx) {
    const prompt = `Apply this learned skill to answer the question.

SKILL: ${sub.name}
SPEC: ${JSON.stringify(spec).slice(0, 800)}

QUESTION: ${question}

Answer in Hinglish, naturally. Show your reasoning briefly. If unsure, say so.`;
    try {
      const out = await this.llm.ask(prompt, { temperature: 0.3, maxTokens: 600 });
      return typeof out === 'string' ? out : out?.reply || '';
    } catch { return null; }
  }

  _matchesSkill(subject, skillName) {
    const s = String(subject).toLowerCase();
    const n = String(skillName).toLowerCase();
    const sT = new Set(s.split(/\s+/));
    const nT = new Set(n.split(/\s+/));
    let hit = 0;
    for (const t of nT) if (sT.has(t)) hit++;
    return hit / Math.max(1, nT.size) >= 0.4;
  }
  _slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40); }

  snapshot() { return Object.fromEntries(this.learningGraph); }
  restore(d) { if (d) this.learningGraph = new Map(Object.entries(d)); }
}

module.exports = SelfBootstrapper;
