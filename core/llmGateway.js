// core/llmGateway.js — Provider-Agnostic LLM Gateway v2.0
'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');

const fetchFn = global.fetch || (() => { try { return require('node-fetch'); } catch { return null; } })();

// ============ LOGGER ============
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];

const log = {
  _w(l, ...a) { if (LOG_LEVELS[l] <= LEVEL) console[l === 'error' ? 'error' : l === 'warn' ? 'warn' : 'log'](`[LLMGateway][${l}]`, ...a); },
  error(...a) { this._w('error', ...a); },
  warn(...a)  { this._w('warn', ...a); },
  info(...a)  { this._w('info', ...a); },
  debug(...a) { this._w('debug', ...a); },
};

// ============ PROVIDER DEFINITIONS ============
const PROVIDERS = {
  groq: {
    name: 'groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKeyEnv: 'GROQ_API_KEY',
    defaultModel: 'openai/gpt-oss-20b',
    modelsEnv: 'GROQ_MODEL',
    supportsTools: true,
    supportsJSON: true,
    supportsVision: true,
    supportsStream: true,
    cost: { input: 0, output: 0 },       // free tier
    maxRetries: 3,
  },
  // 🔮 Future: bas yahan add karo, code automatically adapt karega
  openai: {
    name: 'openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini',
    modelsEnv: 'OPENAI_MODEL',
    supportsTools: true,
    supportsJSON: true,
    supportsVision: true,
    supportsStream: true,
    cost: { input: 0.15 / 1e6, output: 0.60 / 1e6 },
    maxRetries: 2,
  },
  anthropic: {
    name: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-3-5-haiku-20241022',
    modelsEnv: 'ANTHROPIC_MODEL',
    supportsTools: true,
    supportsJSON: true,
    supportsVision: true,
    supportsStream: true,
    cost: { input: 0.80 / 1e6, output: 4.0 / 1e6 },
    maxRetries: 2,
    isAnthropic: true,   // special format
  },
  ollama: {
    name: 'ollama',
    endpoint: (process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1/chat/completions',
    apiKeyEnv: null,
    defaultModel: 'llama3.2',
    modelsEnv: 'OLLAMA_MODEL',
    supportsTools: true,
    supportsJSON: true,
    supportsVision: false,
    supportsStream: true,
    cost: { input: 0, output: 0 },
    maxRetries: 1,
  },
};

// ============ SMART CACHE ============
class ResponseCache {
  constructor(ttl = 300000, max = 300) {
    this.map = new Map();
    this.ttl = ttl;
    this.max = max;
  }
  _key(messages, opts) {
    const payload = JSON.stringify({ m: messages, o: { model: opts.model, t: opts.temperature, tools: opts.tools?.map(t => t.function?.name) } });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }
  get(messages, opts) {
    const k = this._key(messages, opts);
    const v = this.map.get(k);
    if (!v) return null;
    if (Date.now() - v.ts > this.ttl) { this.map.delete(k); return null; }
    return v.data;
  }
  set(messages, opts, data) {
    const k = this._key(messages, opts);
    this.map.set(k, { data, ts: Date.now() });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

// ============ CIRCUIT BREAKER ============
// Agar provider baar baar fail ho → temporarily disable
class CircuitBreaker {
  constructor(failThreshold = 5, resetMs = 60000) {
    this.state = new Map();  // providerName -> { fails, openUntil }
    this.failThreshold = failThreshold;
    this.resetMs = resetMs;
  }
  isOpen(provider) {
    const s = this.state.get(provider);
    if (!s) return false;
    if (s.openUntil && Date.now() < s.openUntil) return true;
    if (s.openUntil && Date.now() >= s.openUntil) { this.state.delete(provider); return false; }
    return false;
  }
  recordFail(provider) {
    const s = this.state.get(provider) || { fails: 0 };
    s.fails++;
    if (s.fails >= this.failThreshold) {
      s.openUntil = Date.now() + this.resetMs;
      log.warn(`🔌 Circuit OPEN for ${provider} (${s.fails} fails). Cooldown ${this.resetMs}ms`);
    }
    this.state.set(provider, s);
  }
  recordSuccess(provider) { this.state.delete(provider); }
  snapshot() {
    const out = {};
    for (const [k, v] of this.state) out[k] = { fails: v.fails, openForMs: v.openUntil ? Math.max(0, v.openUntil - Date.now()) : 0 };
    return out;
  }
}

// ============ METRICS ============
class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.calls = { total: 0, success: 0, failure: 0, retries: 0, cacheHits: 0 };
    this.byProvider = {};
    this.latency = [];
    this.tokens = { input: 0, output: 0, total: 0 };
    this.estimatedCostUSD = 0;
  }
  record({ provider, latencyMs, success, tokens, cost = 0 }) {
    this.calls.total++;
    if (success) this.calls.success++; else this.calls.failure++;
    this.latency.push(latencyMs);
    if (this.latency.length > 500) this.latency.shift();

    if (!this.byProvider[provider]) this.byProvider[provider] = { calls: 0, success: 0, failure: 0, totalMs: 0 };
    this.byProvider[provider].calls++;
    this.byProvider[provider].totalMs += latencyMs;
    if (success) this.byProvider[provider].success++; else this.byProvider[provider].failure++;

    if (tokens) {
      this.tokens.input  += tokens.input  || 0;
      this.tokens.output += tokens.output || 0;
      this.tokens.total  += tokens.total  || 0;
    }
    this.estimatedCostUSD += cost;
  }
  snapshot() {
    const lats = [...this.latency].sort((a, b) => a - b);
    const p = (q) => lats.length ? lats[Math.floor(lats.length * q)] : 0;
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      calls: this.calls,
      byProvider: this.byProvider,
      tokens: this.tokens,
      estimatedCostUSD: +this.estimatedCostUSD.toFixed(6),
      latency: {
        avgMs: lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0,
        p50Ms: p(0.5), p95Ms: p(0.95), p99Ms: p(0.99),
      },
    };
  }
}

// ============ ERROR NORMALIZATION ============
class LLMError extends Error {
  constructor(message, { code, provider, status, retryable = false, raw } = {}) {
    super(message);
    this.name = 'LLMError';
    this.code = code || 'LLM_ERROR';
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
    this.raw = raw;
  }
}

function classifyError(err, provider) {
  const msg = err?.message || String(err);
  const status = err?.status || err?.statusCode;

  if (msg.includes('timeout') || err?.name === 'AbortError') {
    return new LLMError('Request timed out', { code: 'TIMEOUT', provider, retryable: true, raw: err });
  }
  if (status === 429 || msg.includes('rate limit')) {
    return new LLMError('Rate limit hit', { code: 'RATE_LIMIT', provider, status, retryable: true, raw: err });
  }
  if (status === 401 || msg.includes('invalid api key') || msg.includes('unauthorized')) {
    return new LLMError('Invalid API key', { code: 'AUTH', provider, status, retryable: false, raw: err });
  }
  if (status === 400) {
    return new LLMError(msg, { code: 'BAD_REQUEST', provider, status, retryable: false, raw: err });
  }
  if (status >= 500) {
    return new LLMError('Provider server error', { code: 'PROVIDER_5XX', provider, status, retryable: true, raw: err });
  }
  if (msg.includes('ECONNRESET') || msg.includes('ENOTFOUND') || msg.includes('fetch failed')) {
    return new LLMError('Network error', { code: 'NETWORK', provider, retryable: true, raw: err });
  }
  return new LLMError(msg, { code: 'UNKNOWN', provider, retryable: false, raw: err });
}

// ============ UTILS ============
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(ms) { return ms + Math.floor(Math.random() * ms * 0.3); }

function estimateTokens(text) {
  // Rough: 1 token ≈ 4 chars (English + Hinglish ke liye theek)
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') total += estimateTokens(m.content);
    else if (Array.isArray(m.content)) {
      for (const part of m.content) if (part.text) total += estimateTokens(part.text);
    }
    total += 4; // role overhead
  }
  return total;
}

// ============ MAIN GATEWAY ============
class LLMGateway extends EventEmitter {
  constructor(config = {}) {
    super();
    this.currentProvider = config.provider || process.env.LLM_PROVIDER || 'groq';
    this.fallbackChain   = config.fallbackChain || this._defaultFallbackChain();
    this.defaultTimeoutMs = config.timeoutMs || 30000;
    this.cache = config.cache !== false ? new ResponseCache(config.cacheTtlMs || 300000) : null;
    this.breaker = new CircuitBreaker(config.failThreshold || 5, config.resetMs || 60000);
    this.metrics = new Metrics();
    this.debug = config.debug ?? (process.env.LLM_DEBUG === 'true');
  }

  _defaultFallbackChain() {
    const primary = process.env.LLM_PROVIDER || 'groq';
    const chain = [primary];
    for (const name of ['groq', 'openai', 'anthropic', 'ollama']) {
      if (name !== primary && process.env[PROVIDERS[name].apiKeyEnv]) chain.push(name);
    }
    return chain;
  }

  _getProvider(name) {
    const p = PROVIDERS[name];
    if (!p) throw new LLMError(`Unknown provider: ${name}`, { code: 'UNKNOWN_PROVIDER' });
    return p;
  }

  _resolveApiKey(providerDef) {
    if (!providerDef.apiKeyEnv) return null;
    const key = process.env[providerDef.apiKeyEnv];
    if (!key) throw new LLMError(`${providerDef.apiKeyEnv} missing in .env`, { code: 'NO_API_KEY', provider: providerDef.name });
    return key;
  }

  _resolveModel(providerDef, override) {
    return override || process.env[providerDef.modelsEnv] || providerDef.defaultModel;
  }

  // ---- Public: switch provider at runtime ----
  setProvider(name) {
    this._getProvider(name);
    this.currentProvider = name;
    log.info(`🔄 Provider switched to: ${name}`);
    this.emit('providerChanged', { provider: name });
    return this;
  }

  getProvider() { return this.currentProvider; }

  // ---- Public: main chat method ----
  async chat(messages, options = {}) {
    const requestId = options.requestId || crypto.randomBytes(6).toString('hex');
    const startTs = Date.now();

    // Cache check (only for deterministic, non-streaming, non-tool calls)
    const useCache = this.cache && options.cache !== false && !options.stream && !options.tools && (options.temperature ?? 0.5) < 0.3;
    if (useCache) {
      const hit = this.cache.get(messages, options);
      if (hit) {
        this.metrics.calls.cacheHits++;
        log.debug(`[${requestId}] 💾 Cache HIT`);
        return hit;
      }
    }

    const chain = options.providerChain || [this.currentProvider, ...this.fallbackChain.filter(p => p !== this.currentProvider)];
    const tried = [];
    let lastError;

    for (const providerName of chain) {
      if (this.breaker.isOpen(providerName)) {
        log.warn(`[${requestId}] Circuit open for ${providerName}, skipping`);
        tried.push({ provider: providerName, error: 'circuit_open' });
        continue;
      }

      try {
        const result = await this._callWithRetry(providerName, messages, { ...options, requestId });

        // Success
        this.breaker.recordSuccess(providerName);

        const latencyMs = Date.now() - startTs;
        const usage = result.usage || {};
        const tokens = {
          input: usage.prompt_tokens || estimateMessagesTokens(messages),
          output: usage.completion_tokens || estimateTokens(result.content),
          total: usage.total_tokens || 0,
        };
        tokens.total = tokens.total || tokens.input + tokens.output;

        const providerDef = this._getProvider(providerName);
        const cost = (tokens.input * providerDef.cost.input) + (tokens.output * providerDef.cost.output);

        this.metrics.record({ provider: providerName, latencyMs, success: true, tokens, cost });

        // Cache write
        if (useCache) this.cache.set(messages, options, result);

        if (this.debug) {
          log.debug(`[${requestId}] ✅ ${providerName} (${latencyMs}ms, ${tokens.total} tokens, $${cost.toFixed(6)})`);
        }
        this.emit('success', { requestId, provider: providerName, latencyMs, tokens });

        return result;
      } catch (err) {
        const norm = err instanceof LLMError ? err : classifyError(err, providerName);
        lastError = norm;
        tried.push({ provider: providerName, error: norm.code, message: norm.message });

        this.metrics.record({ provider: providerName, latencyMs: Date.now() - startTs, success: false });
        if (norm.retryable || norm.code === 'PROVIDER_5XX') this.breaker.recordFail(providerName);

        log.warn(`[${requestId}] ❌ ${providerName} failed: ${norm.code} — ${norm.message}`);
        this.emit('failure', { requestId, provider: providerName, error: norm });

        // Non-retryable errors → don't try other providers
        if (norm.code === 'AUTH' || norm.code === 'BAD_REQUEST') break;
      }
    }

    const finalErr = new LLMError(
      `All providers failed. Tried: ${tried.map(t => t.provider).join(', ')}`,
      { code: 'ALL_FAILED', raw: { tried, lastError } }
    );
    finalErr.tried = tried;
    throw finalErr;
  }

  async _callWithRetry(providerName, messages, options) {
    const providerDef = this._getProvider(providerName);
    const maxRetries = options.maxRetries ?? providerDef.maxRetries ?? 2;
    let lastErr;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        this.metrics.calls.retries++;
        const backoff = jitter(Math.min(4000, 500 * Math.pow(2, attempt - 1)));
        log.debug(`[${options.requestId}] ⏳ Retry ${attempt}/${maxRetries} in ${backoff}ms`);
        await sleep(backoff);
      }

      try {
        return await this._callProvider(providerName, messages, options);
      } catch (err) {
        lastErr = err;
        const norm = err instanceof LLMError ? err : classifyError(err, providerName);
        if (!norm.retryable) throw norm;
        if (attempt === maxRetries) throw norm;
      }
    }
    throw lastErr;
  }

  async _callProvider(providerName, messages, options) {
    const providerDef = this._getProvider(providerName);
    const apiKey = this._resolveApiKey(providerDef);
    const model  = this._resolveModel(providerDef, options.model);

    if (!fetchFn) throw new LLMError('No fetch available — Node 18+ ya node-fetch install karo', { code: 'NO_FETCH', provider: providerName });

    // Anthropic ka format alag hai
    if (providerDef.isAnthropic) {
      return this._callAnthropic(providerDef, apiKey, model, messages, options);
    }

    // OpenAI-compatible (groq, openai, ollama)
    const body = {
      model,
      messages: this._normalizeMessages(messages),
      temperature: options.temperature ?? 0.5,
      max_tokens: options.maxTokens ?? 1024,
    };

    if (options.tools) {
      body.tools = options.tools;
      body.tool_choice = options.tool_choice || 'auto';
    }
    if (options.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }
    if (options.stop) body.stop = options.stop;
    if (options.topP != null) body.top_p = options.topP;
    if (options.seed != null) body.seed = options.seed;

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchFn(providerDef.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.error) {
        const err = new LLMError(data.error?.message || `HTTP ${res.status}`, {
          provider: providerName,
          status: res.status,
          raw: data,
        });
        throw err;
      }

      const choice = data.choices?.[0];
      if (!choice) throw new LLMError('No choice returned', { code: 'NO_CHOICE', provider: providerName });

      const msg = choice.message || {};
      return {
        role: msg.role || 'assistant',
        content: msg.content || '',
        tool_calls: msg.tool_calls || null,
        finish_reason: choice.finish_reason || null,
        usage: data.usage || null,
        provider: providerName,
        model: data.model || model,
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new LLMError(`Timeout after ${timeoutMs}ms`, { code: 'TIMEOUT', provider: providerName, retryable: true });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async _callAnthropic(providerDef, apiKey, model, messages, options) {
    // System message alag nikalta hai
    let system = '';
    const filtered = [];
    for (const m of messages) {
      if (m.role === 'system') system += (system ? '\n\n' : '') + m.content;
      else filtered.push(m);
    }

    const body = {
      model,
      system: system || undefined,
      messages: filtered,
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0.5,
    };
    if (options.tools) {
      body.tools = options.tools.map(t => ({
        name: t.function?.name, description: t.function?.description, input_schema: t.function?.parameters,
      }));
    }

    const res = await fetchFn(providerDef.endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new LLMError(data.error?.message || `HTTP ${res.status}`, { provider: 'anthropic', status: res.status, raw: data });
    }
    const block = data.content?.find(b => b.type === 'text');
    return {
      role: 'assistant',
      content: block?.text || '',
      tool_calls: null,
      finish_reason: data.stop_reason,
      usage: data.usage ? {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
      } : null,
      provider: 'anthropic',
      model: data.model || model,
    };
  }

  _normalizeMessages(messages) {
    // Content ko string/array mein normalize karo, undefined role hatao
    return messages
      .filter(m => m && m.role && (m.content != null || m.tool_calls || m.tool_call_id))
      .map(m => {
        const out = { role: m.role };
        if (m.content != null) out.content = m.content;
        if (m.tool_calls) out.tool_calls = m.tool_calls;
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        if (m.name) out.name = m.name;
        return out;
      });
  }

  // ---- Convenience: system + user shortcut ----
  async ask(userMessage, options = {}) {
    const messages = [];
    if (options.system) messages.push({ role: 'system', content: options.system });
    messages.push({ role: 'user', content: userMessage });
    const res = await this.chat(messages, options);
    return typeof res === 'string' ? res : res.content;
  }

  // ---- JSON mode: returns parsed object ----
  async askJSON(userMessage, options = {}) {
    const res = await this.ask(userMessage, { ...options, responseFormat: 'json' });
    try {
      return JSON.parse(res);
    } catch {
      // Ek baar retry, extract JSON from text
      const match = String(res).match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new LLMError('Invalid JSON returned by model', { code: 'JSON_PARSE', raw: res });
    }
  }

  // ---- Health check ----
  async healthCheck(providerName) {
    const name = providerName || this.currentProvider;
    const start = Date.now();
    try {
      await this._callProvider(name, [{ role: 'user', content: 'ping' }], { maxTokens: 5, temperature: 0 });
      return { provider: name, ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { provider: name, ok: false, error: err.message, latencyMs: Date.now() - start };
    }
  }

  async healthCheckAll() {
    const out = {};
    for (const name of Object.keys(PROVIDERS)) {
      if (!process.env[PROVIDERS[name].apiKeyEnv]) {
        out[name] = { ok: false, error: 'no api key' };
        continue;
      }
      out[name] = await this.healthCheck(name);
    }
    return out;
  }

  // ---- Stats ----
  getStats() {
    return {
      provider: this.currentProvider,
      fallbackChain: this.fallbackChain,
      cacheSize: this.cache?.size || 0,
      metrics: this.metrics.snapshot(),
      circuitBreakers: this.breaker.snapshot(),
    };
  }

  clearCache() { this.cache?.clear(); }
}

module.exports = new LLMGateway();
module.exports.LLMGateway = LLMGateway;
module.exports.PROVIDERS = PROVIDERS;
module.exports.LLMError = LLMError;
