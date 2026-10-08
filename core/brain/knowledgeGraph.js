
// core/brain/knowledgeGraph.js — Growing Knowledge Base
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LIMITS, checkLimit, audit } = require('./safetyGuards');

const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'knowledge_graph.json');

class KnowledgeGraph {
  constructor() {
    this.nodes = new Map();      // id -> { id, type, content, weight, created, updated, tags }
    this.edges = new Map();      // "a|b" -> { from, to, relation, weight }
    this.loaded = false;
  }

  _hash(content) {
    return crypto.createHash('sha1').update(String(content)).digest('hex').slice(0, 12);
  }

  load() {
    if (this.loaded) return;
    try {
      if (fs.existsSync(DATA_PATH)) {
        const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
        for (const n of raw.nodes || []) this.nodes.set(n.id, n);
        for (const e of raw.edges || []) this.edges.set(`${e.from}|${e.to}`, e);
      }
    } catch (e) {
      console.error('[KnowledgeGraph] load failed:', e.message);
    }
    this.loaded = true;
  }

  save() {
    try {
      const dir = path.dirname(DATA_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const payload = {
        savedAt: new Date().toISOString(),
        nodes: [...this.nodes.values()],
        edges: [...this.edges.values()],
      };
      fs.writeFileSync(DATA_PATH, JSON.stringify(payload, null, 2));
    } catch (e) {
      console.error('[KnowledgeGraph] save failed:', e.message);
    }
  }

  addNode({ type = 'fact', content, weight = 1, tags = [] }) {
    this.load();

    const limit = checkLimit('maxKnowledgeNodes', this.nodes.size);
    if (!limit.ok) return { ok: false, error: limit.reason };

    const id = this._hash(content);
    if (this.nodes.has(id)) {
      const existing = this.nodes.get(id);
      existing.weight = (existing.weight || 1) + 1;
      existing.updated = Date.now();
      this.save();
      return { ok: true, id, updated: true };
    }

    const node = {
      id,
      type,
      content: String(content).slice(0, 1000),
      weight,
      tags,
      created: Date.now(),
      updated: Date.now(),
    };
    this.nodes.set(id, node);
    audit('knowledge_add', { id, type });
    this.save();
    return { ok: true, id, node };
  }

  addEdge(fromId, toId, relation = 'related', weight = 1) {
    this.load();
    const key = `${fromId}|${toId}`;
    if (this.edges.has(key)) {
      const e = this.edges.get(key);
      e.weight = (e.weight || 1) + weight;
      this.save();
      return { ok: true, updated: true };
    }
    const edge = { from: fromId, to: toId, relation, weight, created: Date.now() };
    this.edges.set(key, edge);
    this.save();
    return { ok: true, edge };
  }

  search(query, limit = 5) {
    this.load();
    const q = String(query).toLowerCase();
    const scored = [];

    for (const n of this.nodes.values()) {
      const content = String(n.content).toLowerCase();
      let score = 0;
      if (content.includes(q)) score += 10;
      for (const tag of n.tags || []) if (tag.toLowerCase().includes(q)) score += 3;
      if (score > 0) scored.push({ ...n, score: score * (n.weight || 1) });
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  getNeighbors(nodeId, depth = 1) {
    this.load();
    const visited = new Set([nodeId]);
    let frontier = [nodeId];

    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const [k, e] of this.edges) {
        if (frontier.includes(e.from) && !visited.has(e.to)) {
          visited.add(e.to); next.push(e.to);
        }
        if (frontier.includes(e.to) && !visited.has(e.from)) {
          visited.add(e.from); next.push(e.from);
        }
      }
      frontier = next;
    }

    visited.delete(nodeId);
    return [...visited].map(id => this.nodes.get(id)).filter(Boolean);
  }

  stats() {
    this.load();
    const byType = {};
    for (const n of this.nodes.values()) {
      byType[n.type] = (byType[n.type] || 0) + 1;
    }
    return {
      nodes: this.nodes.size,
      edges: this.edges.size,
      byType,
      maxAllowed: LIMITS.maxKnowledgeNodes,
    };
  }

  prune(maxNodes = LIMITS.maxKnowledgeNodes) {
    this.load();
    if (this.nodes.size <= maxNodes) return { pruned: 0 };

    // Lowest weight + oldest prune karo
    const sorted = [...this.nodes.values()].sort((a, b) => {
      if (a.weight !== b.weight) return (a.weight || 1) - (b.weight || 1);
      return a.updated - b.updated;
    });

    const toRemove = sorted.slice(0, this.nodes.size - maxNodes);
    for (const n of toRemove) {
      this.nodes.delete(n.id);
      for (const [k, e] of this.edges) {
        if (e.from === n.id || e.to === n.id) this.edges.delete(k);
      }
    }
    this.save();
    audit('knowledge_pruned', { count: toRemove.length });
    return { pruned: toRemove.length };
  }
}

module.exports = new KnowledgeGraph();
