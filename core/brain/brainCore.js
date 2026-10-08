// core/brain/brainCore.js — Main Brain Orchestrator
'use strict';

const EventEmitter = require('events');
const llm = require('../llmGateway');
const knowledge = require('./knowledgeGraph');
const goals = require('./goalEngine');
const strategies = require('./strategyEngine');
const reflection = require('./reflectionEngine');
const codeAdvisor = require('./codeAdvisor');
const { audit, sanityCheck } = require('./safetyGuards');
const taskAgent = require('../../agents/taskAgent'); // 🔥 Task Agent ko dimaag se jod diya

class BrainCore extends EventEmitter {
  constructor() {
    super();
    this.thoughts = [];      // recent reasoning trace
    this.maxThoughts = 200;
    this.startedAt = Date.now();
    this._registerDefaultStrategies();
  }

  _registerDefaultStrategies() {
    strategies.register('direct_answer',   { category: 'chat',       description: 'Answer directly from knowledge' });
    strategies.register('web_search',      { category: 'live_data',  description: 'Search web for live data' });
    strategies.register('knowledge_lookup',{ category: 'recall',     description: 'Search own knowledge graph' });
    strategies.register('reflect_then_act',{ category: 'complex',    description: 'Reflect before acting' });
    strategies.register('tool_chain',      { category: 'complex',    description: 'Multiple tools in sequence' });
  }

  _think(step) {
    const entry = { ts: Date.now(), ...step };
    this.thoughts.push(entry);
    if (this.thoughts.length > this.maxThoughts) this.thoughts.shift();
    this.emit('thought', entry);
  }

  // 🧠 Main "think" method — har query yahan se guzarti hai
  async think(userMessage, options = {}) {
    const start = Date.now();
    this._think({ stage: 'input', message: userMessage });

    // 1. Knowledge recall
    const recalled = knowledge.search(userMessage, 3);
    if (recalled.length) {
      this._think({ stage: 'recall', hits: recalled.length });
    }

    // 2. Pick strategy
    const category = this._classifyIntent(userMessage, recalled);
    const chosenStrategy = strategies.pick(category) || 'direct_answer';
    this._think({ stage: 'strategy', chosen: chosenStrategy, category });

    // 3. Build context
    const context = {
      recalled: recalled.map(r => r.content),
      userMessage,
      strategy: chosenStrategy,
      goalsSnapshot: goals.prioritized(3),
      reflectionSummary: reflection.summary(20),
    };

    // 4. Execute via LLM
    let reply = '';
    let success = false;
    try {
      reply = await this._executeStrategy(chosenStrategy, context, options);
      success = true;
    } catch (e) {
      reply = `Boss, kuch gadbad ho gayi: ${e.message}`;
      success = false;
    }

    const latencyMs = Date.now() - start;

    // 5. Reflect on the action
    const reflectionResult = await reflection.reflect({
      action: chosenStrategy,
      input: userMessage,
      output: reply,
      success,
      latencyMs,
      strategyName: chosenStrategy,
    });

    // 6. Store knowledge from this interaction
    if (success && reply.length > 20) {
      knowledge.addNode({
        type: 'interaction',
        content: `Q: ${userMessage.slice(0, 200)} | Strategy: ${chosenStrategy}`,
        tags: [category, chosenStrategy],
        weight: 1,
      });
    }

    this._think({ stage: 'output', latencyMs, success, strategy: chosenStrategy });

    return {
      reply,
      strategy: chosenStrategy,
      latencyMs,
      reflection: { insights: reflectionResult.insights, lessons: reflectionResult.lessons },
      recalledCount: recalled.length,
    };
  }

  _classifyIntent(message, recalled = []) {
    const m = String(message).toLowerCase();

    // Simple heuristics — AI ke judgment se upar local filter
    if (/\b(kya|kaise|kab|kahan|kaun|kitna|bta|batao)\b/.test(m) && recalled.length > 0) {
      return 'recall';
    }
    if (/\b(aaj|abhi|current|latest|live|rate|price|weather|news|score)\b/.test(m)) {
      return 'live_data';
    }
    if (m.length > 100 || /\b(plan|design|architect|strategy|analyze)\b/.test(m)) {
      return 'complex';
    }
    return 'chat';
  }

  // 🔥 Yahan aapka naya code add kiya gaya hai
  async _executeStrategy(strategy, context, options) {
    
    // NAYA JADOO: Agar internet ya tools ki zaroorat hai, toh taskAgent se karwao
    if (strategy === 'web_search' || strategy === 'live_data' || strategy === 'tool_chain') {
      try {
        console.log(`[Brain] Handing over task to TaskAgent. Strategy: ${strategy}`);
        // Yahan aapke taskAgent ka jo bhi main function hai (jaise process, run, ya execute), wo call hoga
        const agentResponse = await taskAgent.process(context.userMessage); 
        return agentResponse;
      } catch (err) {
        return `Boss, main net pe gaya tha par taskAgent fail ho gaya: ${err.message}`;
      }
    }

    // NORMAL CHAT & RECALL: Baaki simple sawalon ke liye default LLM
    const system = `You are Nexus Brain — self-aware, learning AI.
Current strategy: ${strategy}
Your goals (top 3): ${context.goalsSnapshot.map(g => g.title).join(' | ') || 'none'}
Recent success rate: ${context.reflectionSummary.successRate || 'N/A'}
${context.recalled.length ? `Recalled knowledge:\n${context.recalled.map(r => '- ' + r).join('\n')}` : ''}

Reply in Hinglish. Be concise. If you don't know something, say so honestly.`;

    return await llm.ask(context.userMessage, {
      system,
      temperature: options.temperature ?? 0.6,
      maxTokens: options.maxTokens ?? 800,
    });
  }

  // 🎯 Self-set goals based on recent reflections
  async considerNewGoals() {
    const summary = reflection.summary(50);
    const stale = goals.stale();

    const newGoals = [];

    // Failed interactions se goals banao
    if (summary.successRate < 0.7 && summary.count > 10) {
      const r = goals.addGoal({
        title: 'Improve success rate above 85%',
        description: `Current: ${(summary.successRate * 100).toFixed(1)}%`,
        priority: 8,
        tags: ['meta', 'performance'],
        source: 'self-reflection',
      });
      if (r.ok) newGoals.push(r.goal);
    }

    // Stale goals ke liye reminder
    for (const s of stale.slice(0, 3)) {
      this._think({ stage: 'stale_goal', goalId: s.id, title: s.title });
    }

    return { newGoals, staleCount: stale.length };
  }

  // 🔧 Self code review
  async reviewOwnCode(files = []) {
    if (!files.length) return { ok: false, error: 'no files provided' };
    return await codeAdvisor.selfScan(files);
  }

  // 📊 Full health snapshot
  snapshot() {
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      thoughts: this.thoughts.slice(-10),
      knowledge: knowledge.stats(),
      goals: goals.stats(),
      strategies: strategies.stats(),
      reflections: reflection.summary(50),
      codeSuggestions: codeAdvisor.stats(),
    };
  }

  // 🗣️ Natural language status
  async explainSelf() {
    const snap = this.snapshot();
    const prompt = `Summarize this AI brain status in 4-5 lines of Hinglish for the CEO.

Knowledge: ${snap.knowledge.nodes} nodes, ${snap.knowledge.edges} edges
Goals: ${snap.goals.active} active, ${snap.goals.total} total
Strategies: ${snap.strategies.total} tracked
Success rate: ${(snap.reflections.successRate * 100).toFixed(1)}%
Pending code suggestions: ${snap.codeSuggestions.byStatus.pending || 0}

Be professional, positive, and concise.`;

    return await llm.ask(prompt, { temperature: 0.5, maxTokens: 300 });
  }
}

module.exports = new BrainCore();
