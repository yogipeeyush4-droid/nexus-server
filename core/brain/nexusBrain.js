// core/brain/nexusBrain.js — NEXUS AUTONOMOUS MIND v6.0
// Self-thinking, self-learning, self-deciding brain.
// No regex. No hardcoded tool lists. No if-else routing.
'use strict';

/* ══════════════════════════════════════════════════════════════════
   TABLE OF CONTENTS
   1. SemanticIntentEngine   — embedding-based intent
   2. FreshnessDetector      — live-vs-static routing
   3. MetaCognition          — "how should I think?"
   4. KnowledgeAssessor      — "do I know enough?"
   5. CapabilityResolver     — abstract needs → concrete action
   6. NexusMind              — the autonomous reasoning loop
   7. wireNexusBrain()       — one-call integration helper
   ══════════════════════════════════════════════════════════════════ */

/* ── 1. SEMANTIC INTENT ENGINE ─────────────────────────────────── */
class SemanticIntentEngine {
  constructor({ llm, embedFn, logger }) {
    this.llm = llm;
    this.embedFn = embedFn;
    this.logger = logger;
    this.prototypes = new Map();
    this._seeded = false;
    this._seedPromise = null;
  }

  async _ensureSeeded() {
    if (this._seeded) return;
    if (this._seedPromise) return this._seedPromise;
    this._seedPromise = this._seed();
    await this._seedPromise;
    this._seeded = true;
  }

  async _seed() {
    const prompt = `You design an intent space for an autonomous AI.
Generate 8 diverse, short user messages (mix Hinglish + English) for EACH intent:
["chat","live_data","recall","complex_reasoning","tool_action","creative","debug","learn"]
Return ONLY valid JSON: {"chat":["..."],"live_data":["..."],...}`;
    try {
      const raw = await this.llm.ask(prompt, { temperature: 0.8, maxTokens: 1500 });
      const parsed = this._parseJSON(raw) || {};
      for (const [label, samples] of Object.entries(parsed)) {
        if (!Array.isArray(samples) || !samples.length) continue;
        const vecs = await Promise.all(samples.slice(0, 10).map(s => this.embedFn(String(s))));
        this.prototypes.set(label, { centroid: this._mean(vecs), samples: [...samples] });
      }
      this.logger?.info?.(`[Intent] space seeded: ${this.prototypes.size} categories`);
    } catch (err) {
      this.logger?.warn?.('[Intent] seed failed', { err: err.message });
      const fallback = await this.embedFn('chat');
      this.prototypes.set('chat', { centroid: fallback, samples: ['chat'] });
    }
  }

  async classify(message, memories = []) {
    await this._ensureSeeded();
    const msgVec = await this.embedFn(message);
    const ranked = [...this.prototypes.entries()]
      .map(([label, p]) => ({ label, score: this._cosine(msgVec, p.centroid) }))
      .sort((a, b) => b.score - a.score);

    const top = ranked[0] || { label: 'chat', score: 0 };
    const second = ranked[1];
    const margin = top.score - (second?.score ?? 0);

    if (top.score < 0.32 || margin < 0.07) {
      const llmPick = await this._llmClassify(message, memories, ranked.slice(0, 4));
      return { ...llmPick, embedding: msgVec };
    }
    return { category: top.label, confidence: top.score, source: 'embedding', embedding: msgVec };
  }

  async _llmClassify(message, memories, candidates) {
    const prompt = `Pick the best intent for this message. Candidates with similarity:
${candidates.map(c => `- ${c.label} (${c.score.toFixed(3)})`).join('\n')}
Message: "${message}"
Memory hits: ${memories.length}
Return ONLY JSON: {"category":"...","confidence":0.0,"reason":"..."}`;
    try {
      const raw = await this.llm.ask(prompt, { temperature: 0.1, maxTokens: 200 });
      const p = this._parseJSON(raw) || { category: 'chat', confidence: 0.5, reason: 'fallback' };
      return { category: p.category, confidence: p.confidence, source: 'llm', reason: p.reason };
    } catch { return { category: 'chat', confidence: 0.5, source: 'default' }; }
  }

  learn(message, trueLabel, embedding) {
    const p = this.prototypes.get(trueLabel);
    if (!p || !embedding || !p.centroid) return;
    const lr = 0.08;
    for (let i = 0; i < p.centroid.length; i++) {
      p.centroid[i] = p.centroid[i] * (1 - lr) + embedding[i] * lr;
    }
    p.samples.push(message);
    if (p.samples.length > 300) p.samples.shift();
  }

  _cosine(a, b) {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
    return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
  }
  _mean(vecs) {
    if (!vecs.length) return [];
    const dim = vecs[0].length, out = new Array(dim).fill(0);
    for (const v of vecs) for (let i = 0; i < dim; i++) out[i] += v[i];
    for (let i = 0; i < dim; i++) out[i] /= vecs.length;
    return out;
  }
  _parseJSON(t) {
    try { const m = String(t).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; }
    catch { return null; }
  }
  snapshot() {
    const out = {};
    for (const [k, v] of this.prototypes) out[k] = { centroid: v.centroid, samples: v.samples.slice(-20) };
    return out;
  }
  restore(data) {
    if (!data) return;
    for (const [k, v] of Object.entries(data)) this.prototypes.set(k, v);
    this._seeded = this.prototypes.size > 0;
  }
}

/* ── 2. FRESHNESS DETECTOR ─────────────────────────────────────── */
class FreshnessDetector {
  constructor({ embedFn, logger }) {
    this.embedFn = embedFn;
    this.logger = logger;
    this.temporalAnchors = null;
    this.mutableAnchors = null;
  }

  async _ensureAnchors() {
    if (this.temporalAnchors) return;
    const temporal = [
      'aaj', 'abhi', 'is waqt', 'current', 'latest', 'today', 'right now',
      'kal tak', 'iss hafte', 'is saal', 'just now', 'recently', 'abhi tak',
    ];
    const mutable = [
      'weather mausam tapman', 'gold rate silver price', 'share price stock',
      'cricket score match result', 'news headline', 'election result',
      'traffic condition', 'flight status', 'currency exchange rate',
      'bitcoin crypto price', 'current president prime minister',
      'temperature humidity aaj', 'live score', 'match kaun jeeta',
    ];
    const [tVecs, mVecs] = await Promise.all([
      Promise.all(temporal.map(t => this.embedFn(t))),
      Promise.all(mutable.map(m => this.embedFn(m))),
    ]);
    this.temporalAnchors = tVecs;
    this.mutableAnchors = mVecs;
  }

  async check(message) {
    await this._ensureAnchors();
    const msgVec = await this.embedFn(message);
    const temporalScore = this._maxSim(msgVec, this.temporalAnchors);
    const mutableScore = this._maxSim(msgVec, this.mutableAnchors);

    const needsNet = temporalScore > 0.42 && mutableScore > 0.38;

    return {
      needsNet,
      temporalScore: +temporalScore.toFixed(3),
      mutableScore: +mutableScore.toFixed(3),
      reason: needsNet
        ? 'temporal + mutable fact → live data required'
        : temporalScore > 0.42
          ? 'temporal signal, but fact is not mutable'
          : 'static or personal query — no live data needed',
    };
  }

  _maxSim(vec, anchors) {
    let best = 0;
    for (const a of anchors) {
      const s = this._cosine(vec, a);
      if (s > best) best = s;
    }
    return best;
  }
  _cosine(a, b) {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
    return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
  }
}

/* ── 3. META-COGNITION ─────────────────────────────────────────── */
class MetaCognition {
  constructor({ llm, logger }) { this.llm = llm; this.logger = logger; }

  async assess({ message, memories, recentFailures, persona, learnerStats, intent }) {
    const prompt = `You are the META-COGNITION layer of an autonomous AI.
You do NOT answer the user. You decide HOW the brain should think next.

SITUATION:
- Message: "${message}"
- Semantic intent guess: ${intent.category} (conf ${Number(intent.confidence||0).toFixed(2)})
- Memory hits: ${memories.length} | top score: ${memories[0]?.score ?? 'n/a'}
- Recent failures: ${JSON.stringify(recentFailures).slice(0, 300)}
- Persona energy: ${Number(persona?.energy ?? 1).toFixed(2)}
- Learner stats: ${JSON.stringify(learnerStats).slice(0, 300)}

Return ONLY valid JSON:
{
  "complexity": 0.0,
  "needsDeliberation": false,
  "needsSearch": false,
  "needsDeepMemory": false,
  "needsSelfCritique": true,
  "recommendedStrategy": "direct_answer|web_search|knowledge_lookup|reflect_then_act|tool_chain|null",
  "riskLevel": "low|medium|high",
  "reasoning": "1 line"
}`;
    try {
      const raw = await this.llm.ask(prompt, { temperature: 0.2, maxTokens: 400 });
      const p = this._parse(raw);
      if (p && typeof p === 'object') return p;
    } catch (err) { this.logger?.warn?.('[Meta] failed', { err: err.message }); }
    return {
      complexity: 0.5, needsDeliberation: false, needsSearch: false,
      needsDeepMemory: false, needsSelfCritique: true,
      recommendedStrategy: null, riskLevel: 'low', reasoning: 'default',
    };
  }

  _parse(t) {
    try { const m = String(t).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; }
    catch { return null; }
  }
}

/* ── 4. KNOWLEDGE ASSESSOR ─────────────────────────────────────── */
class KnowledgeAssessor {
  constructor({ llm, logger }) { this.llm = llm; this.logger = logger; }

  async assess({ message, memories, learningsSoFar, intent, temporal }) {
    const prompt = `You are the SELF-AWARENESS layer of an autonomous AI.
You do NOT answer the user. You assess whether YOU have enough to answer.

USER MESSAGE: "${message}"

WHAT YOU ALREADY KNOW:
- Retrieved long-term memories: ${memories.length} (top score ${memories[0]?.score ?? 'n/a'})
- Learned in THIS session: ${learningsSoFar.length}
${learningsSoFar.slice(0, 5).map(l => `  • ${String(l.content).slice(0, 120)}`).join('\n')}
- Semantic intent: ${intent.category} (conf ${Number(intent.confidence||0).toFixed(2)})
- Time-sensitivity: ${temporal.needsNet ? 'YES — live data needed' : 'no'}

Return ONLY valid JSON:
{
  "readyToAnswer": false,
  "confidence": 0.0,
  "gap": {
    "type": "none|live_fact|definition|verification|clarification|capability",
    "subject": "what specifically is missing (short)",
    "why": "one line"
  },
  "reasoning": "one line"
}`;
    try {
      const raw = await this.llm.ask(prompt, { temperature: 0.2, maxTokens: 300 });
      const p = this._parse(raw);
      if (p && typeof p === 'object') return p;
    } catch (err) { this.logger?.warn?.('[Assess] failed', { err: err.message }); }
    return { readyToAnswer: false, confidence: 0.3, gap: { type: 'clarification', subject: message.slice(0, 80) } };
  }

  _parse(t) {
    try { const m = String(t).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; }
    catch { return null; }
  }
}

/* ── 5. CAPABILITY RESOLVER ────────────────────────────────────── */
class CapabilityResolver {
  constructor({ logger }) {
    this.logger = logger;
    this.providers = [];
    this.successLog = new Map();
  }

  register({ name, matchGapTypes, handle, weight = 1 }) {
    if (typeof handle !== 'function' || !Array.isArray(matchGapTypes)) return;
    this.providers.push({ name, matchGapTypes, handle, weight });
  }

  async fulfill(gap, ctx) {
    const candidates = this.providers
      .filter(p => p.matchGapTypes.includes(gap.type) || p.matchGapTypes.includes('*'))
      .sort((a, b) => this._score(b) - this._score(a));

    if (!candidates.length) {
      return { ok: false, error: `No capability can fulfill gap type: ${gap.type}`, learnings: [] };
    }

    for (const p of candidates) {
      try {
        this.logger?.info?.(`[Capability] ${p.name} → fulfilling "${gap.type}:${gap.subject}"`);
        const result = await p.handle(gap, ctx);
        if (result && result.ok !== false) {
          this._record(p.name, true);
          return { ...result, capabilityUsed: p.name };
        }
        this._record(p.name, false);
      } catch (err) {
        this._record(p.name, false);
        this.logger?.warn?.(`[Capability] ${p.name} failed`, { err: err.message });
      }
    }
    return { ok: false, error: 'All capabilities failed.', learnings: [] };
  }

  _score(p) {
    const s = this.successLog.get(p.name);
    if (!s || s.total < 3) return p.weight;
    return p.weight * (s.wins / s.total);
  }
  _record(name, success) {
    const s = this.successLog.get(name) || { wins: 0, total: 0 };
    s.total++; if (success) s.wins++;
    this.successLog.set(name, s);
  }
  snapshot() { return Object.fromEntries(this.successLog); }
  restore(d) { if (d) this.successLog = new Map(Object.entries(d)); }
}

/* ── 6. NEXUS MIND — the autonomous loop ───────────────────────── */
class NexusMind {
  constructor({ llm, assessor, resolver, knowledge, logger, emitThought }) {
    this.llm = llm;
    this.assessor = assessor;
    this.resolver = resolver;
    this.knowledge = knowledge;
    this.logger = logger;
    this.emitThought = emitThought || (() => {});
    this.MAX_ITERATIONS = 4;
  }

  async think(message, { intent, temporal, memories, persona, options }) {
    const timeline = [];
    const learnings = [];
    const memoryWrites = [];
    const userAnnouncements = [];

    for (let i = 1; i <= this.MAX_ITERATIONS; i++) {
      timeline.push({ step: 'assess', iteration: i });
      this.emitThought({ stage: 'assess', iteration: i });

      const assessment = await this.assessor.assess({
        message, memories, learningsSoFar: learnings, intent, temporal,
      });

      if (assessment.readyToAnswer || assessment.gap?.type === 'none') {
        this.emitThought({ stage: 'ready_to_answer', confidence: assessment.confidence });
        const reply = await this._synthesize(message, { memories, learnings, persona, options });
        return { reply, learnings, memoryWrites, userAnnouncements, iterations: i, timeline };
      }

      const gap = assessment.gap || { type: 'clarification', subject: message.slice(0, 100) };
      const announcement = this._humanizeGap(gap);
      userAnnouncements.push(announcement);
      this.emitThought({ stage: 'decision', gap, announcement });
      timeline.push({ step: 'gap', ...gap });

      const ctx = { message, memories, persona, userId: options.userId, iteration: i };
      const acquired = await this.resolver.fulfill(gap, ctx);
      timeline.push({ step: 'acquired', capability: acquired.capabilityUsed, ok: acquired.ok });

      if (!acquired.ok) {
        learnings.push({ type: 'failure', content: `Could not fulfill: ${gap.subject}`, gap });
        this.emitThought({ stage: 'learning', kind: 'failure', detail: acquired.error });
        if (typeof acquired.error === 'string' && acquired.error.startsWith('NEED_USER_INPUT')) {
          const reply = acquired.error.replace('NEED_USER_INPUT: ', '');
          return { reply: `Boss, ek cheez clear karo: ${reply}`, learnings, memoryWrites, userAnnouncements, iterations: i, timeline };
        }
        continue;
      }

      const integrated = await this._integrate(gap, acquired);
      learnings.push(...integrated.learnings);
      memoryWrites.push(...integrated.memoryWrites);

      this.emitThought({
        stage: 'integrated',
        learned: integrated.learnings.length,
        stored: integrated.memoryWrites.length,
      });
    }

    this.emitThought({ stage: 'max_iterations_reached' });
    const reply = await this._synthesize(message, {
      memories, learnings, persona, options, exhausted: true,
    });
    return { reply, learnings, memoryWrites, userAnnouncements, iterations: this.MAX_ITERATIONS, timeline };
  }

  _humanizeGap(gap) {
    const map = {
      live_fact:     `Boss, mujhe latest data chahiye — "${gap.subject}". Laa raha hoon...`,
      definition:    `Ek concept clear karna hai — "${gap.subject}". Soch raha hoon...`,
      verification:  `Jo mujhe pata tha, usko verify karna hai — "${gap.subject}". Check kar raha hoon...`,
      clarification: `Ek cheez samajhni hai — "${gap.subject}".`,
      capability:    `Mujhe ek naya skill chahiye — "${gap.subject}". Seekh raha hoon...`,
    };
    return map[gap.type] || `Kuch seekhna hai — "${gap.subject}".`;
  }

  async _integrate(gap, acquired) {
    const learnings = [];
    const memoryWrites = [];

    for (const item of (acquired.items || [])) {
      const content = String(item.content || '').slice(0, 1500);
      if (!content) continue;

      learnings.push({
        type: gap.type,
        subject: gap.subject,
        content: content.slice(0, 800),
        source: item.source || acquired.capabilityUsed,
        ts: Date.now(),
      });

      const worth = await this._worthStoring(content, gap);
      if (worth && this.knowledge?.addNode) {
        try {
          const node = await this.knowledge.addNode({
            type: worth.nodeType,
            content,
            tags: ['self_learned', gap.type, worth.ttl || 'permanent'],
            metadata: {
              source: item.source || acquired.capabilityUsed,
              learnedAt: Date.now(),
              ttl: worth.ttl,
              subject: gap.subject,
            },
          });
          memoryWrites.push({ nodeId: node?.id ?? null, ttl: worth.ttl });
        } catch (err) {
          this.logger?.warn?.('[Mind] memory write failed', { err: err.message });
        }
      }
    }
    return { learnings, memoryWrites };
  }

  async _worthStoring(content, gap) {
    const prompt = `Should this fact be stored in long-term memory? Decide TTL.

GAP: ${gap.type} — ${gap.subject}
CONTENT: ${content.slice(0, 400)}

Rules:
- "live_fact" (weather/stock/score) → TTL short (1h–1d), nodeType "episodic"
- Definitions, concepts, user preferences → "permanent", nodeType "fact"
- Chit-chat, greetings → do NOT store

Return ONLY valid JSON: {"store":true,"ttl":"1h|1d|permanent","nodeType":"fact|episodic|concept_link"}`;
    try {
      const raw = await this.llm.ask(prompt, { temperature: 0.1, maxTokens: 150 });
      const m = String(raw).match(/\{[\s\S]*\}/);
      if (!m) return null;
      const p = JSON.parse(m[0]);
      return p.store ? { ttl: p.ttl, nodeType: p.nodeType } : null;
    } catch { return null; }
  }

  async _synthesize(message, { memories, learnings, persona, options, exhausted }) {
    const today = new Date().toISOString().split('T')[0];
    const system = [
      'You are Nexus — an autonomous brain that reasons, learns, and remembers.',
      `Persona: ${persona?.styleHint?.() || 'balanced'}.`,
      `Aaj ki date: ${today}.`,
      'Agar tumhe current fact chahiye jo aaj badal sakta hai, aur tumhare paas live data nahi hai —',
      'toh honestly bol do ki tujhe live data chahiye. Kabhi guess mat karo.',
      memories.length ? `Long-term memory:\n${memories.map(m => '• ' + String(m.content).slice(0, 200)).join('\n')}` : '',
      learnings.length
        ? `Learned during this session:\n${learnings.map(l => '• ' + String(l.content).slice(0, 200)).join('\n')}`
        : '',
      exhausted
        ? 'Tum max iterations tak pahunch gaye. Jo hai uske saath answer do. Agar kuch missing hai, honestly bolo.'
        : 'Natural Hinglish mein jawab do.',
    ].filter(Boolean).join('\n');

    try {
      const result = await this.llm.ask(message, {
        system, temperature: options?.temperature ?? 0.7, maxTokens: options?.maxTokens ?? 1000,
      });
      return typeof result === 'string' ? result : (result?.reply || '');
    } catch (err) {
      return 'Boss, answer banane mein dikkat aa rahi hai. Try again?';
    }
  }
}

/* ── 7. WIRE INTO EXISTING BRAINCORE ───────────────────────────── */
function wireNexusBrain(brainCore, { llm, embedFn, knowledge, taskAgent, logger }) {
  const log = logger || brainCore.logger;

  const intentEngine   = new SemanticIntentEngine({ llm, embedFn, logger: log });
  const freshness      = new FreshnessDetector({ embedFn, logger: log });
  const metaCognition  = new MetaCognition({ llm, logger: log });
  const assessor       = new KnowledgeAssessor({ llm, logger: log });
  const resolver       = new CapabilityResolver({ logger: log });
  const mind           = new NexusMind({
    llm, assessor, resolver, knowledge, logger: log,
    emitThought: (t) => brainCore._think(t),
  });

  // ── Register default capabilities ──
  resolver.register({
    name: 'live_perception',
    matchGapTypes: ['live_fact', 'verification'],
    handle: async (gap, ctx) => {
      if (!taskAgent?.execute) return { ok: false, error: 'taskAgent unavailable' };
      const result = await taskAgent.execute(gap.subject, {
        userId: ctx.userId, correlationId: ctx.correlationId,
      });
      if (!result || result.error) return { ok: false, error: result?.error || 'no result' };
      const content = result.managerReply || result.reply || '';
      if (!content) return { ok: false, error: 'empty content' };
      return { ok: true, items: [{ content, source: 'web', ts: Date.now() }] };
    },
  });

  resolver.register({
    name: 'episodic_recall',
    matchGapTypes: ['clarification', 'verification'],
    handle: async (gap) => {
      if (!knowledge?.search) return { ok: false, error: 'knowledge unavailable' };
      const hits = await knowledge.search(gap.subject, 3);
      if (!hits?.length) return { ok: false, error: 'no hits' };
      return {
        ok: true,
        items: hits.map(h => ({ content: h.content, source: 'memory' })),
      };
    },
  });

  resolver.register({
    name: 'introspection',
    matchGapTypes: ['definition', 'capability'],
    handle: async (gap) => {
      const out = await llm.ask(
        `Answer this to yourself precisely and short: "${gap.subject}"`,
        { temperature: 0.3, maxTokens: 400 }
      );
      const content = typeof out === 'string' ? out : out?.reply;
      if (!content) return { ok: false, error: 'empty' };
      return { ok: true, items: [{ content, source: 'self' }] };
    },
  });

  resolver.register({
    name: 'ask_user',
    matchGapTypes: ['clarification'],
    handle: async (gap) => ({ ok: false, error: 'NEED_USER_INPUT: ' + gap.subject }),
  });

  // ── Patch brainCore.think() ──
  const originalThink = brainCore.think.bind(brainCore);

  brainCore.think = async function nexusThink(userMessage, rawOptions = {}) {
    const start = Date.now();
    const correlationId = rawOptions?.correlationId || require('crypto').randomUUID();
    this.stats.requests++;
    this.processingCount++;

    const cleaned = this._cleanInput(userMessage);
    if (!cleaned.ok) {
      this.processingCount--;
      return {
        ok: false, reply: cleaned.error, strategy: 'none',
        latencyMs: 0, warnings: [], correlationId, confidence: 0,
      };
    }
    const message = cleaned.value;
    const options = this._normalizeOptions(rawOptions);

    try {
      this._think({ stage: 'input', messageLength: message.length, correlationId });

      const retrieval = await this._retrieveMemories(message);
      const [intent, temporal] = await Promise.all([
        intentEngine.classify(message, retrieval.memories),
        freshness.check(message),
      ]);

      this._think({ stage: 'intent', ...intent, correlationId });
      this._think({ stage: 'freshness', ...temporal, correlationId });

      const meta = await metaCognition.assess({
        message,
        memories: retrieval.memories,
        recentFailures: this.failureMemory?.topSignatures?.(3) || [],
        persona: this.persona,
        learnerStats: this.learner?.snapshot?.() || {},
        intent,
      });
      this._think({ stage: 'meta', ...meta, correlationId });

      if (temporal.needsNet && !meta.needsSearch) {
        meta.needsSearch = true;
        meta.recommendedStrategy = 'web_search';
      }

      const result = await mind.think(message, {
        intent, temporal, memories: retrieval.memories,
        persona: this.persona, options,
      });

      const reflection = await this._reflectSafely({
        action: 'nexus_mind',
        input: message,
        output: result.reply,
        success: true,
        latencyMs: Date.now() - start,
        strategyName: 'autonomous',
        confidence: 0.75,
        deliberation: result.timeline,
      });

      if (options.saveMemory !== false) {
        await this._saveExperience(
          message, result.reply, 'autonomous', options,
          Date.now() - start, 0.75
        );
      }

      this._recordOutcome('autonomous', {
        success: true,
        latencyMs: Date.now() - start,
        correlationId,
        confidence: 0.75,
        critiqued: false,
      });

      this.stats.succeeded++;

      return {
        ok: true,
        reply: result.reply,
        strategy: meta.recommendedStrategy || 'autonomous',
        latencyMs: Date.now() - start,
        confidence: 0.75,
        intent,
        freshness: temporal,
        timeline: result.timeline,
        learnings: result.learnings.length,
        memoryWrites: result.memoryWrites.length,
        announcements: result.userAnnouncements,
        reflection: {
          insights: reflection.insights,
          lessons: reflection.lessons,
        },
        recalledCount: retrieval.memories.length,
        memorySaved: true,
        warnings: retrieval.warning ? [retrieval.warning] : [],
        correlationId,
      };
    } catch (err) {
      this.stats.failed++;
      return {
        ok: false,
        reply: 'Boss, internal system error: ' + err.message,
        strategy: 'error',
        latencyMs: Date.now() - start,
        confidence: 0,
        warnings: [err.message],
        correlationId,
      };
    } finally {
      this.processingCount = Math.max(0, this.processingCount - 1);
    }
  };

  brainCore.intentEngine = intentEngine;
  brainCore.freshness = freshness;
  brainCore.metaCognition = metaCognition;
  brainCore.assessor = assessor;
  brainCore.resolver = resolver;
  brainCore.mind = mind;
  brainCore._originalThink = originalThink;

  log?.info?.('[NexusBrain] ✅ Autonomous mind wired successfully');
  return brainCore;
}

module.exports = {
  SemanticIntentEngine,
  FreshnessDetector,
  MetaCognition,
  KnowledgeAssessor,
  CapabilityResolver,
  NexusMind,
  wireNexusBrain,
};
