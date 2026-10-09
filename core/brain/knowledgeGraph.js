// core/brain/knowledgeGraph.js — Cloud-Powered Infinite Memory (Hybrid Local + Pinecone)
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LIMITS, checkLimit, audit } = require('./safetyGuards');

/* ────────────────────────── CONFIG ────────────────────────── */
const DATA_PATH  = path.join(__dirname, '..', '..', 'data', 'knowledge_graph.json');
const QUEUE_PATH = path.join(__dirname, '..', '..', 'data', 'kg_sync_queue.json');

// Hardcoded Credentials (Zero setup required)
const PINECONE_API_KEY = 'PCsk_28bfwS_HnbSsfnPoWWG7h6F3xuZNwmUvtQhbcPMSgZFLboXsm8kjQzAboQn8ZJ1uV5su8R';
const PINECONE_HOST    = 'https://nexusforge-r285o3m.svc.aped-4627-b74a.pinecone.io';
const PINECONE_NS      = 'brain-default';
const HAS_CLOUD        = Boolean(PINECONE_API_KEY && PINECONE_HOST);

const EMBED_DIM        = 384;
const SAVE_DEBOUNCE_MS = 1200;
const SYNC_INTERVAL_MS = 8000;
const SYNC_BATCH       = 40;
const SYNC_MAX_RETRY   = 6;
const RECENCY_HALFLIFE = 1000 * 60 * 60 * 24 * 14;   // 14 din
const AUTO_EDGE_MIN_SIM = 0.62;
const AUTO_EDGE_TOPK    = 4;
const CACHE_MAX         = 200;

if (!HAS_CLOUD) {
  console.warn('[KG] Cloud disabled. Local-only mode active.');
}

/* ────────────────────────── UTILS ─────────────────────────── */
const l2norm = (arr) => {
  let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < arr.length; i++) arr[i] /= s;
  return arr;
};
const cosine = (a, b) => {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const fnv1a = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

/* ══════════════════════════ CLASS ═══════════════════════════ */
class KnowledgeGraph {
  constructor() {
    this.nodes    = new Map();   // id -> node
    this.edges    = new Map();   // "a|b" -> edge
    this.adj      = new Map();   // id -> Set<neighborId>   (O(1) traversal)
    this.vectors  = new Map();   // id -> Float32Array
    this.docLens  = new Map();   // id -> token count (BM25)
    this.df       = new Map();   // token -> doc frequency
    this.N        = 0;
    this.totalLen = 0;

    this.syncQueue  = [];        // [{op:'upsert'|'delete', payload, tries}]
    this.queryCache = new Map(); // LRU
    this.loaded     = false;
    this._saveTimer = null;
    this._syncTimer = null;
    this._syncing   = false;
  }

  /* ─── helpers ───────────────────────────────────────────── */
  _hash(content) {
    return crypto.createHash('sha1').update(String(content)).digest('hex').slice(0, 12);
  }

  _tokenize(text) {
    return String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\u0900-\u097F\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);
  }

  /** Offline fallback embedding — feature-hashed word + char-trigram bag. */
  _embed(text) {
    const v = new Float32Array(EMBED_DIM);
    const toks = this._tokenize(text);
    for (const t of toks) {
      v[fnv1a(t) % EMBED_DIM] += 1;
      for (let i = 0; i < t.length - 2; i++) {
        v[fnv1a(t.slice(i, i + 3)) % EMBED_DIM] += 0.5;
      }
    }
    return l2norm(v);
  }

  /* ─── persistence ───────────────────────────────────────── */
  load() {
    if (this.loaded) return;
    try {
      if (fs.existsSync(DATA_PATH)) {
        const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
        for (const n of raw.nodes || []) this._indexNode(n, /*embed*/ true);
        for (const e of raw.edges || []) this._indexEdge(e);
      }
      if (fs.existsSync(QUEUE_PATH)) {
        this.syncQueue = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8')) || [];
      }
    } catch (e) {
      console.error('[KG] load failed:', e.message);
    }
    this.loaded = true;
    if (HAS_CLOUD && this.syncQueue.length) this._startSyncWorker();
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
  }

  flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try {
      const dir = path.dirname(DATA_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const payload = {
        savedAt: new Date().toISOString(),
        nodes: [...this.nodes.values()].map(n => ({
          ...n,
          _vec: this.vectors.has(n.id) ? Array.from(this.vectors.get(n.id)) : undefined,
        })),
        edges: [...this.edges.values()],
      };
      fs.writeFileSync(DATA_PATH, JSON.stringify(payload));
      fs.writeFileSync(QUEUE_PATH, JSON.stringify(this.syncQueue));
    } catch (e) {
      console.error('[KG] save failed:', e.message);
    }
  }

  /* ─── indexing ──────────────────────────────────────────── */
  _indexNode(node, withEmbed = false) {
    this.nodes.set(node.id, node);

    // Vector
    let vec;
    if (withEmbed && Array.isArray(node._vec)) vec = Float32Array.from(node._vec);
    else vec = this._embed(node.content);
    this.vectors.set(node.id, vec);
    if (node._vec) delete node._vec;

    // BM25 stats
    const toks = this._tokenize(node.content);
    this.docLens.set(node.id, toks.length);
    this.totalLen += toks.length;
    this.N += 1;
    const seen = new Set();
    for (const t of toks) if (!seen.has(t)) { seen.add(t); this.df.set(t, (this.df.get(t) || 0) + 1); }

    if (!this.adj.has(node.id)) this.adj.set(node.id, new Set());
  }

  _unindexNode(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    const toks = this._tokenize(node.content);
    for (const t of new Set(toks)) {
      const c = (this.df.get(t) || 0) - 1;
      if (c <= 0) this.df.delete(t); else this.df.set(t, c);
    }
    this.totalLen -= (this.docLens.get(id) || 0);
    this.N -= 1;
    this.docLens.delete(id);
    this.vectors.delete(id);
    this.nodes.delete(id);
    this.adj.delete(id);
    for (const [k, e] of this.edges) {
      if (e.from === id || e.to === id) {
        this.edges.delete(k);
        this.adj.get(e.from)?.delete(e.to);
        this.adj.get(e.to)?.delete(e.from);
      }
    }
  }

  _indexEdge(e) {
    this.edges.set(`${e.from}|${e.to}`, e);
    if (!this.adj.has(e.from)) this.adj.set(e.from, new Set());
    if (!this.adj.has(e.to))   this.adj.set(e.to,   new Set());
    this.adj.get(e.from).add(e.to);
    this.adj.get(e.to).add(e.from);
  }

  /* ─── cloud sync ────────────────────────────────────────── */
  _enqueue(op, payload) {
    this.syncQueue.push({ op, payload, tries: 0, ts: Date.now() });
    if (HAS_CLOUD) this._startSyncWorker();
    this._scheduleSave();
  }

  _startSyncWorker() {
    if (this._syncTimer || !HAS_CLOUD) return;
    this._syncTimer = setInterval(() => this._drainSyncQueue(), SYNC_INTERVAL_MS);
    this._drainSyncQueue();
  }

  async _drainSyncQueue() {
    if (this._syncing || !HAS_CLOUD || !this.syncQueue.length) return;
    this._syncing = true;
    const batch = this.syncQueue.slice(0, SYNC_BATCH);
    const upserts = batch.filter(b => b.op === 'upsert').map(b => b.payload);
    const deletes = batch.filter(b => b.op === 'delete').map(b => b.payload);
    try {
      if (upserts.length) {
        await fetch(`${PINECONE_HOST}/vectors/upsert`, {
          method: 'POST',
          headers: { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ vectors: upserts, namespace: PINECONE_NS }),
        }).then(r => { if (!r.ok) throw new Error(`upsert ${r.status}`); });
      }
      if (deletes.length) {
        await fetch(`${PINECONE_HOST}/vectors/delete`, {
          method: 'POST',
          headers: { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: deletes.map(d => d.id), namespace: PINECONE_NS }),
        }).then(r => { if (!r.ok) throw new Error(`delete ${r.status}`); });
      }
      this.syncQueue.splice(0, batch.length);
      this._scheduleSave();
    } catch (err) {
      for (const b of batch) {
        b.tries++;
        b.ts = Date.now();
        if (b.tries > SYNC_MAX_RETRY) {
          console.error('[KG] Dropping sync item after retries:', err.message);
          this.syncQueue.splice(this.syncQueue.indexOf(b), 1);
        }
      }
      this._scheduleSave();
    } finally {
      this._syncing = false;
    }
  }

  /* ─── public API: write ─────────────────────────────────── */
  addNode({ type = 'fact', content, weight = 1, tags = [] }) {
    this.load();
    const lim = checkLimit('maxKnowledgeNodes', this.nodes.size);
    if (!lim.ok) return { ok: false, error: lim.reason };

    const text = String(content).slice(0, 1000);
    const id = this._hash(text);

    if (this.nodes.has(id)) {
      const ex = this.nodes.get(id);
      ex.weight = (ex.weight || 1) + 1;
      ex.updated = Date.now();
      this._scheduleSave();
      this._enqueue('upsert', {
        id, values: Array.from(this.vectors.get(id)),
        metadata: { type: ex.type, content: ex.content, weight: ex.weight, tags: ex.tags, updated: ex.updated },
      });
      return { ok: true, id, updated: true };
    }

    const node = { id, type, content: text, weight, tags, created: Date.now(), updated: Date.now() };
    this._indexNode(node);
    audit('knowledge_add', { id, type });

    const autoEdges = this._autoEdge(node);
    this._scheduleSave();

    this._enqueue('upsert', {
      id, values: Array.from(this.vectors.get(id)),
      metadata: { type, content: text, weight, tags, created: node.created, updated: node.updated },
    });

    return { ok: true, id, node, autoEdges };
  }

  _autoEdge(node) {
    const v = this.vectors.get(node.id);
    const scored = [];
    for (const [id, ov] of this.vectors) {
      if (id === node.id) continue;
      const s = cosine(v, ov);
      if (s >= AUTO_EDGE_MIN_SIM) scored.push([id, s]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    const created = [];
    for (const [to, s] of scored.slice(0, AUTO_EDGE_TOPK)) {
      const edge = { from: node.id, to, relation: 'auto_similar', weight: Number(s.toFixed(3)), created: Date.now() };
      this._indexEdge(edge);
      created.push({ to, sim: s });
    }
    return created;
  }

  addEdge(fromId, toId, relation = 'related', weight = 1) {
    this.load();
    const key = `${fromId}|${toId}`;
    if (this.edges.has(key)) {
      const e = this.edges.get(key);
      e.weight = (e.weight || 1) + weight;
      this._scheduleSave();
      return { ok: true, updated: true };
    }
    const edge = { from: fromId, to: toId, relation, weight, created: Date.now() };
    this._indexEdge(edge);
    this._scheduleSave();
    return { ok: true, edge };
  }

  /* ─── public API: read ──────────────────────────────────── */
  _bm25(queryToks, node) {
    if (!queryToks.length) return 0;
    const tf = new Map();
    for (const t of this._tokenize(node.content)) tf.set(t, (tf.get(t) || 0) + 1);
    const dl = this.docLens.get(node.id) || 1;
    const avg = this.totalLen / Math.max(1, this.N);
    const k1 = 1.5, b = 0.75;
    let score = 0;
    for (const q of queryToks) {
      const f = tf.get(q) || 0;
      if (!f) continue;
      const df = this.df.get(q) || 0;
      const idf = Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / avg));
    }
    return score;
  }

  async search(query, limit = 5) {
    this.load();
    const q = String(query).trim();
    if (!q) return [];

    const cacheKey = `${q}::${limit}`;
    if (this.queryCache.has(cacheKey)) return this.queryCache.get(cacheKey);

    const qToks = this._tokenize(q);
    const qVec  = this._embed(q);
    const now   = Date.now();

    const local = [];
    for (const n of this.nodes.values()) {
      const bm25 = this._bm25(qToks, n);
      const cos  = cosine(qVec, this.vectors.get(n.id));
      if (bm25 === 0 && cos < 0.25) continue;

      let tagHit = 0;
      for (const tag of n.tags || []) {
        if (qToks.some(t => tag.toLowerCase().includes(t))) tagHit += 1;
      }
      const age = now - (n.updated || n.created || now);
      const recency = Math.exp(-age / RECENCY_HALFLIFE);
      const w = Math.log1p(n.weight || 1);

      const score =
        0.35 * Math.tanh(bm25) +
        0.35 * cos +
        0.10 * Math.tanh(tagHit) +
        0.10 * recency +
        0.10 * w;

      local.push({ ...n, score, _source: 'local', _bm25: bm25, _cos: cos });
    }
    local.sort((a, b) => b.score - a.score);

    let cloud = [];
    if (HAS_CLOUD) {
      try {
        const r = await fetch(`${PINECONE_HOST}/query`, {
          method: 'POST',
          headers: { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vector: Array.from(qVec),
            topK: limit * 3,
            includeMetadata: true,
            namespace: PINECONE_NS,
          }),
        });
        if (r.ok) {
          const data = await r.json();
          for (const m of data.matches || []) {
            if (!this.nodes.has(m.id)) continue;
            cloud.push({ id: m.id, cloudScore: m.score });
          }
        }
      } catch (e) { /* silently degrade */ }
    }

    const merged = new Map();
    for (const n of local.slice(0, limit * 4)) merged.set(n.id, n);
    for (const c of cloud) {
      if (merged.has(c.id)) merged.get(c.id).score += 0.15 * c.cloudScore;
      else {
        const n = this.nodes.get(c.id);
        if (n) merged.set(c.id, { ...n, score: 0.15 * c.cloudScore, _source: 'cloud' });
      }
    }

    const result = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);

    this.queryCache.set(cacheKey, result);
    if (this.queryCache.size > CACHE_MAX) {
      this.queryCache.delete(this.queryCache.keys().next().value);
    }
    return result;
  }

  getNeighbors(nodeId, depth = 1) {
    this.load();
    if (!this.adj.has(nodeId)) return [];
    const visited = new Set([nodeId]);
    let frontier = [nodeId];

    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const id of frontier) {
        for (const nb of this.adj.get(id) || []) {
          if (!visited.has(nb)) { visited.add(nb); next.push(nb); }
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }

    visited.delete(nodeId);
    return [...visited]
      .map(id => this.nodes.get(id))
      .filter(Boolean)
      .sort((a, b) => (b.weight || 1) - (a.weight || 1));
  }

  stats() {
    this.load();
    const byType = {};
    for (const n of this.nodes.values()) byType[n.type] = (byType[n.type] || 0) + 1;
    const avgDegree = this.nodes.size
      ? (2 * this.edges.size / this.nodes.size).toFixed(2) : 0;
    return {
      nodes: this.nodes.size,
      edges: this.edges.size,
      avgDegree,
      byType,
      maxAllowed: LIMITS.maxKnowledgeNodes,
      cloudSyncEnabled: HAS_CLOUD,
      pendingSync: this.syncQueue.length,
      vocabSize: this.df.size,
    };
  }

  prune(maxNodes = LIMITS.maxKnowledgeNodes) {
    this.load();
    if (this.nodes.size <= maxNodes) return { pruned: 0 };

    const sorted = [...this.nodes.values()].sort((a, b) => {
      const wa = (a.weight || 1) * Math.exp(-(Date.now() - (a.updated || a.created)) / RECENCY_HALFLIFE);
      const wb = (b.weight || 1) * Math.exp(-(Date.now() - (b.updated || b.created)) / RECENCY_HALFLIFE);
      return wa - wb;
    });

    const toRemove = sorted.slice(0, this.nodes.size - maxNodes);
    for (const n of toRemove) {
      this._unindexNode(n.id);
      this._enqueue('delete', { id: n.id });
    }
    this._scheduleSave();
    audit('knowledge_pruned', { count: toRemove.length });
    return { pruned: toRemove.length };
  }

  async close() {
    this.flush();
    await this._drainSyncQueue();
    if (this._syncTimer) clearInterval(this._syncTimer);
  }
}

module.exports = new KnowledgeGraph();
