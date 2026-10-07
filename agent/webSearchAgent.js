/**
 * Google Search + Tavily AI Search — Unified Tool
 * Supports: Serper (Google) + Tavily (AI-enhanced)
 *
 * Usage:
 *   const { doLiveSearch } = require('./googleSearch');
 *   const result = await doLiveSearch('best pizza in mumbai');
 */

const fetch = global.fetch || require('node-fetch');

// ============ API KEYS ============
const SERPER_API_KEY = process.env.SERPER_API_KEY ||
  '2696a75bf385577ff2b4798428dd24de8ce5ee51';

const TAVILY_API_KEY = process.env.TAVILY_API_KEY ||
  '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';

// ============ ENDPOINTS ============
const SERPER_URL = 'https://google.serper.dev/search';
const TAVILY_URL = 'https://api.tavily.com/search';

// ============ CONFIG ============
const CONFIG = {
  timeoutMs: 12000,
  defaultLimit: 10,
  cacheTtlMs: 5 * 60 * 1000,
};

// ============ CACHE ============
const cache = new Map();

function cacheKey(q, opts) {
  return `${q}::${JSON.stringify(opts || {})}`.toLowerCase();
}

function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { cache.delete(k); return null; }
  return e.value;
}

function cacheSet(k, v) {
  cache.set(k, { value: v, expiresAt: Date.now() + CONFIG.cacheTtlMs });
}

// ============ UTILS ============
async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return url;
  }
}

function dedupeResults(results) {
  const seen = new Map();
  for (const r of results) {
    const key = normalizeUrl(r.link || r.url || '');
    if (!key) continue;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

// ============ SERPER (Google) ============
async function searchSerper(query, opts = {}) {
  const body = {
    q: query,
    num: Math.min(opts.limit || CONFIG.defaultLimit, 20),
    gl: opts.gl || 'in',
    hl: opts.hl || 'en',
  };

  if (opts.site) body.q = `site:${opts.site} ${query}`;

  const res = await withTimeout(
    fetch(SERPER_URL, {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    CONFIG.timeoutMs,
    'serper'
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Serper ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();

  const results = (data.organic || []).map((r) => ({
    title: r.title || '',
    link: r.link || '',
    snippet: r.snippet || '',
    position: r.position || null,
    source: 'serper',
  }));

  const answer = data.answerBox?.answer ||
                 data.answerBox?.snippet ||
                 data.knowledgeGraph?.description || null;

  const related = (data.relatedSearches || []).map((r) => r.query);

  return {
    provider: 'serper',
    query,
    answer,
    results,
    related,
    count: results.length,
    raw: data,
  };
}

// ============ TAVILY (AI Search) ============
async function searchTavily(query, opts = {}) {
  const body = {
    api_key: TAVILY_API_KEY,
    query,
    max_results: Math.min(opts.limit || CONFIG.defaultLimit, 20),
    search_depth: opts.deep ? 'advanced' : 'basic',
    include_answer: true,
    include_raw_content: false,
    topic: opts.topic || 'general',
    include_domains: opts.includeDomains || undefined,
    exclude_domains: opts.excludeDomains || undefined,
  };

  const res = await withTimeout(
    fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    CONFIG.timeoutMs,
    'tavily'
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();

  const results = (data.results || []).map((r) => ({
    title: r.title || '',
    link: r.url || '',
    snippet: r.content || '',
    score: r.score || null,
    source: 'tavily',
  }));

  return {
    provider: 'tavily',
    query,
    answer: data.answer || null,
    results,
    related: [],
    count: results.length,
    raw: data,
  };
}

// ============ MERGE ============
function mergeResults(serperRes, tavilyRes) {
  const all = [
    ...(serperRes?.results || []),
    ...(tavilyRes?.results || []),
  ];

  const deduped = dedupeResults(all);

  // Sort: Serper position first, then Tavily score
  deduped.sort((a, b) => {
    if (a.source === 'serper' && b.source === 'serper') {
      return (a.position || 99) - (b.position || 99);
    }
    if (a.source === 'tavily' && b.source === 'tavily') {
      return (b.score || 0) - (a.score || 0);
    }
    return 0;
  });

  // Prefer Tavily answer (AI), then Serper answerBox
  const answer = tavilyRes?.answer || serperRes?.answer || null;

  const related = [
    ...new Set([
      ...(serperRes?.related || []),
      ...(tavilyRes?.related || []),
    ]),
  ];

  return {
    answer,
    results: deduped,
    related,
    providers: [
      serperRes && 'serper',
      tavilyRes && 'tavily',
    ].filter(Boolean),
  };
}

// ============ MAIN FUNCTION ============
/**
 * Live search using Serper + Tavily.
 *
 * @param {string} query
 * @param {Object} opts
 *   - provider: 'auto' | 'serper' | 'tavily' | 'both' | 'race'
 *   - limit: number (default 10)
 *   - deep: use Tavily advanced mode
 *   - topic: 'general' | 'news'
 *   - site: restrict to a site
 *   - cache: enable cache (default true)
 */
async function doLiveSearch(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Query is required');

  const options = {
    provider: opts.provider || 'auto',
    limit: opts.limit || CONFIG.defaultLimit,
    deep: !!opts.deep,
    topic: opts.topic || 'general',
    site: opts.site || null,
    gl: opts.gl || 'in',
    hl: opts.hl || 'en',
    cache: opts.cache !== false,
  };

  // Cache check
  const ck = cacheKey(q, options);
  if (options.cache) {
    const hit = cacheGet(ck);
    if (hit) return { ...hit, cached: true };
  }

  const provider = options.provider;
  let serperRes = null;
  let tavilyRes = null;

  // --- RACE: fastest provider wins ---
  if (provider === 'race') {
    const res = await Promise.any([
      searchSerper(q, options),
      searchTavily(q, options),
    ]);
    const merged = mergeResults(
      res.provider === 'serper' ? res : null,
      res.provider === 'tavily' ? res : null
    );
    const out = {
      success: true,
      query: q,
      provider: res.provider,
      ...merged,
      cached: false,
    };
    if (options.cache) cacheSet(ck, out);
    return out;
  }

  // --- SINGLE PROVIDER ---
  if (provider === 'serper') {
    serperRes = await searchSerper(q, options);
  } else if (provider === 'tavily') {
    tavilyRes = await searchTavily(q, options);
  }

  // --- BOTH: parallel, tolerate individual failures ---
  else if (provider === 'both' || provider === 'auto') {
    const settled = await Promise.allSettled([
      searchSerper(q, options),
      searchTavily(q, options),
    ]);

    serperRes = settled[0].status === 'fulfilled' ? settled[0].value : null;
    tavilyRes = settled[1].status === 'fulfilled' ? settled[1].value : null;

    if (!serperRes && !tavilyRes) {
      const errors = [
        `serper: ${settled[0].reason?.message || 'failed'}`,
        `tavily: ${settled[1].reason?.message || 'failed'}`,
      ];
      throw new Error(`All providers failed — ${errors.join(' | ')}`);
    }
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const merged = mergeResults(serperRes, tavilyRes);

  const out = {
    success: true,
    query: q,
    providers: merged.providers,
    answer: merged.answer,
    results: merged.results,
    related: merged.related,
    count: merged.results.length,
    cached: false,
  };

  if (options.cache) cacheSet(ck, out);

  return out;
}

// ============ SHORTCUTS ============
async function quickSearch(query, opts = {}) {
  return doLiveSearch(query, { ...opts, provider: 'race', limit: opts.limit || 5 });
}

async function deepSearch(query, opts = {}) {
  return doLiveSearch(query, { ...opts, provider: 'both', deep: true, limit: opts.limit || 15 });
}

async function newsSearch(query, opts = {}) {
  return doLiveSearch(query, { ...opts, provider: 'tavily', topic: 'news' });
}

// ============ WHATSAPP FORMAT ============
function formatForWhatsApp(data, opts = {}) {
  if (!data || !data.success) {
    return `❌ Search failed: ${data?.error || 'unknown error'}`;
  }

  const lines = [];
  const maxResults = opts.maxResults || 5;
  const maxSnippet = opts.maxSnippet || 140;

  if (data.answer) {
    lines.push(`💡 *Answer:*`);
    lines.push(String(data.answer).slice(0, 400));
    lines.push('');
  }

  const results = data.results || [];
  if (results.length) {
    lines.push(`🔎 *Top Results:*`);
    results.slice(0, maxResults).forEach((r, i) => {
      const snippet = r.snippet
        ? r.snippet.replace(/\s+/g, ' ').slice(0, maxSnippet) +
          (r.snippet.length > maxSnippet ? '…' : '')
        : '';
      lines.push(`${i + 1}. *${escapeWA(r.title)}*`);
      if (snippet) lines.push(`   ${escapeWA(snippet)}`);
      lines.push(`   🔗 ${r.link}`);
      lines.push('');
    });
  }

  if (opts.includeRelated && data.related?.length) {
    lines.push(`🔗 *Related:*`);
    lines.push(data.related.slice(0, 4).map((q) => `• ${q}`).join('\n'));
  }

  return lines.join('\n').trim();
}

function escapeWA(s) {
  return String(s).replace(/[_*~`]/g, '');
}

// ============ EXPORTS ============
module.exports = {
  doLiveSearch,
  quickSearch,
  deepSearch,
  newsSearch,
  formatForWhatsApp,
  searchSerper,
  searchTavily,
  clearCache: () => cache.clear(),
  getCacheSize: () => cache.size,
};

