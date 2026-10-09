// core/embeddings.js — embedding provider wrapper
'use strict';

const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const cache = new Map();

async function embedFn(text) {
  const key = String(text).slice(0, 500);
  if (cache.has(key)) return cache.get(key);

  const r = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: String(text),
  });
  const v = r.data[0].embedding;
  cache.set(key, v);
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return v;
}

module.exports = embedFn;
