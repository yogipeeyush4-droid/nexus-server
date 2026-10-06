const express = require('express');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { exec } = require('child_process');
const { doLiveSearch } = require('./api_tools/googleSearch');

// ═══════════════════════════════════════════════
// 🔐 SECURITY LAYER (Sirf Khatarnak Commands Block rahengi)
// ═══════════════════════════════════════════════
// Whitelist (SAFE_COMMANDS) hata di gayi hai, ab sab allow hai

const BLOCKED_PATTERNS = [
  /rm\s+-rf/i, /sudo/i, /chmod/i, /chown/i, /mkfs/i,
  /dd\s+if=/i, />\s*\/dev\//i, /curl.*\|\s*(sh|bash)/i,
  /wget.*\|\s*(sh|bash)/i, /eval/i, /base64\s+-d/i,
  /nc\s+-/i, /ncat/i, /\/etc\/passwd/i, /\/etc\/shadow/i,
  /kill\s+-9\s+1/i, /:\(\)\{.*\};:/i,  // fork bomb
];

function isCommandSafe(command) {
  // Bas blocked (khatarnak) patterns check karo
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) return { safe: false, reason: 'Blocked pattern detected' };
  }
  // Agar khatarnak nahi hai, toh sab allow (jaise mkdir, file banana aadi)
  return { safe: true, tool: 'System_Command' };
}

// ═══════════════════════════════════════════════
// ⚙️ SAFE COMMAND EXECUTOR
// ═══════════════════════════════════════════════
function executeRealCommand(command, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const check = isCommandSafe(command);
    if (!check.safe) {
      console.log(`🚫 Blocked: ${command} (${check.reason})`);
      return resolve({ ok: false, error: `Security block: ${check.reason}` });
    }

    exec(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        console.log(`❌ Exec Error: ${error.message}`);
        return resolve({ ok: false, error: error.message });
      }
      console.log(`✅ Exec: ${stdout.slice(0, 100)}`);
      resolve({ ok: true, output: stdout || 'Task completed.', tool: check.tool });
    });
  });
}

// ═══════════════════════════════════════════════
// 🧠 SMART MEMORY MANAGER (File lock + Cache)
// ═══════════════════════════════════════════════
const MEMORY_FILE = './aiMemory.json';
const DYNAMIC_CODE_FILE = './dynamicCode.js';
const CONVERSATION_FILE = './conversations.json';

const safeBaselineMemory = {
  evolutionVersion: "2.1.0",
  learnedConcepts: [
    "Basic Swarm Routing",
    "Multi-Agent Collaboration",
    "Secure API Gateway",
    "Auto-Rollback Shield Active",
    "Unlocked Command Execution",
    "Infinite Conversation Memory"
  ],
  lastEvolutionTimestamp: new Date().toISOString()
};

function initFiles() {
  if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, JSON.stringify(safeBaselineMemory, null, 2));
  if (!fs.existsSync(DYNAMIC_CODE_FILE)) fs.writeFileSync(DYNAMIC_CODE_FILE, "// AI Dynamic Code\nmodule.exports = {};");
  if (!fs.existsSync(CONVERSATION_FILE)) fs.writeFileSync(CONVERSATION_FILE, JSON.stringify({}, null, 2));
}

class MemoryStore {
  constructor(file) {
    this.file = file;
    this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.writeLock = false;
  }
  read() { return this.data; }
  async write(newData) {
    this.data = newData;
    if (this.writeLock) return;
    this.writeLock = true;
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    setTimeout(() => { this.writeLock = false; }, 100);
  }
}

initFiles();
let aiMemory = new MemoryStore(MEMORY_FILE);

// ═══════════════════════════════════════════════
// 📜 CONVERSATION HISTORY (Puri Baatein Yaad Rakhne ke liye)
// ═══════════════════════════════════════════════
class ConversationStore {
  constructor(file) {
    this.file = file;
    this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  getHistory(userId) { return this.data[userId] || []; }
  add(userId, role, content) {
    if (!this.data[userId]) this.data[userId] = [];
    this.data[userId].push({ role, content, ts: Date.now() });
    // Yahan se delete/slice logic hata diya hai, ab sab memory mein rahega
    this._persist();
  }
  clear(userId) { delete this.data[userId]; this._persist(); }
  _persist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    }, 500);
  }
}
const conversations = new ConversationStore(CONVERSATION_FILE);

// ═══════════════════════════════════════════════
// 🛡️ RATE LIMITER
// ═══════════════════════════════════════════════
const rateLimits = new Map();
function rateLimit(ip, maxPerMin = 30) {
  const now = Date.now();
  const bucket = rateLimits.get(ip) || { count: 0, reset: now + 60000 };
  if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + 60000; }
  bucket.count++;
  rateLimits.set(ip, bucket);
  return bucket.count <= maxPerMin;
}

// ═══════════════════════════════════════════════
// 🌐 EXPRESS APP
// ═══════════════════════════════════════════════
const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-Auth-Token');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function authGuard(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  const validTokens = (process.env.AUTH_TOKENS || '').split(',').filter(Boolean);
  if (validTokens.length === 0) return next();
  if (!validTokens.includes(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.use('/api/', (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!rateLimit(ip)) return res.status(429).json({ error: 'Too many requests, slow down' });
  next();
});

app.get('/', (req, res) => {
  res.send(`
    <h1>NexusForge Core v${aiMemory.read().evolutionVersion} ONLINE 🛡️</h1>
    <p>Learned concepts: ${aiMemory.read().learnedConcepts.length}</p>
    <p>Status: <b>POWER FULL</b> ⚡</p>
  `);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: aiMemory.read().evolutionVersion,
    uptime: process.uptime(),
    memory: aiMemory.read()
  });
});

app.get('/api/memory', authGuard, (req, res) => {
  res.json(aiMemory.read());
});

app.delete('/api/memory/concept/:index', authGuard, (req, res) => {
  const mem = aiMemory.read();
  const idx = parseInt(req.params.index);
  if (idx >= 0 && idx < mem.learnedConcepts.length) {
    const removed = mem.learnedConcepts.splice(idx, 1);
    aiMemory.write(mem);
    res.json({ status: 'removed', concept: removed[0] });
  } else {
    res.status(400).json({ error: 'Invalid index' });
  }
});

app.post('/api/conversation/clear', authGuard, (req, res) => {
  const { userId } = req.body || {};
  conversations.clear(userId || 'default');
  res.json({ status: 'cleared' });
});

// ═══════════════════════════════════════════════
// 🎯 MAIN SWARM ENDPOINT
// ═══════════════════════════════════════════════
app.post('/api/swarm', authGuard, async (req, res) => {
  const { command, userId = 'default', useHistory = true } = req.body || {};
  const safeCommand = (command || 'Hello').toString().slice(0, 2000);
  const lowerCmd = safeCommand.toLowerCase();

  const isLearningCommand = /\b(learn|evolve|update yourself|yaad rakh|remember)\b/i.test(lowerCmd);
  const isSearchCommand = /\b(search|latest|@research_ai|bhav|price|news|kya hai|aaj|rate|kab|kaun|when|who)\b/i.test(lowerCmd);
  const isExecCommand = /\b(run|execute|chala|karo|show|dikhao)\b/i.test(lowerCmd);

  try {
    const currentMemory = aiMemory.read();

    let systemPrompt = `You are NexusManager, an autonomous AI CEO assistant for NexusForge.
Current external memory: ${JSON.stringify(currentMemory.learnedConcepts)}
Version: ${currentMemory.evolutionVersion}

RULES:
1. Be concise, professional, and slightly witty.
2. If user wants to run a command (like creating a folder or file), format your response with: [EXECUTE: <exact command>]
3. Never hallucinate. If unsure, say so.
4. Reply in the same language as user (Hindi/English/Hinglish).`;

    if (isLearningCommand) {
      systemPrompt += `\n\nLEARNING MODE: User is teaching you something new.
Reply naturally acknowledging it, and END your response with: [LEARNED: <concise summary>]`;
    }

    if (isSearchCommand) {
      try {
        const liveData = await doLiveSearch(safeCommand);
        systemPrompt += `\n\n[LIVE INTERNET DATA from @Research_AI]:\n${liveData}\n\nUse this data to answer accurately.`;
      } catch (e) {
        console.error('Search module error:', e.message);
      }
    }

    const messages = [{ role: 'system', content: systemPrompt }];
    
    // Naya badlav: Yahan se limit hata di gayi hai. AI pichli PURI history uthayegi.
    if (useHistory) {
      const history = conversations.getHistory(userId); 
      messages.push(...history.map(h => ({ role: h.role, content: h.content })));
    }
    messages.push({ role: 'user', content: `Command: ${safeCommand}` });

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'openai/gpt-oss-20b',
        messages,
        temperature: 0.7,
        max_tokens: 1024
      })
    });

    if (!response.ok) throw new Error(`AI API ${response.status}`);

    const data = await response.json();
    if (!data.choices?.[0]?.message?.content) {
      return res.json({ status: 'empty', managerReply: 'Shield intercepted empty response.' });
    }

    let aiReply = data.choices[0].message.content;

    if (/\b(syntax error|system crash|panic|fatal error)\b/i.test(aiReply)) {
      await aiMemory.write(JSON.parse(JSON.stringify(safeBaselineMemory)));
      return res.json({
        status: 'rolled_back',
        managerReply: `[AUTO-ROLLBACK 🛡️] Reverted to v${safeBaselineMemory.evolutionVersion}.`
      });
    }

    if (isLearningCommand) {
      const match = aiReply.match(/\[LEARNED:\s*(.*?)\]/i);
      if (match?.[1]) {
        const concept = match[1].trim().slice(0, 200);
        const mem = aiMemory.read();
        if (!mem.learnedConcepts.includes(concept)) {
          mem.learnedConcepts.push(concept);
        }
        const v = parseFloat(mem.evolutionVersion) + 0.1;
        mem.evolutionVersion = v.toFixed(1);
        mem.lastEvolutionTimestamp = new Date().toISOString();
        await aiMemory.write(mem);
        aiReply = aiReply.replace(/\[LEARNED:\s*(.*?)\]/gi, '').trim();
      }
    }

    if (aiReply.includes('[EXECUTE:')) {
      const cmdMatch = aiReply.match(/\[EXECUTE:\s*(.*?)\]/i);
      if (cmdMatch?.[1]) {
        const commandToRun = cmdMatch[1].trim();
        console.log(`⚙️ AI Action: ${commandToRun}`);
        const result = await executeRealCommand(commandToRun);
        aiReply = aiReply.replace(/\[EXECUTE:\s*(.*?)\]/gi, '').trim();
        aiReply += result.ok
          ? `\n\n✅ [TOOL EXECUTED]\n${result.output}`
          : `\n\n🚫 [BLOCKED]\n${result.error}`;
      }
    }

    if (useHistory) {
      conversations.add(userId, 'user', safeCommand);
      conversations.add(userId, 'assistant', aiReply);
    }

    res.json({
      status: 'success',
      version: aiMemory.read().evolutionVersion,
      managerReply: `[SHIELD ACTIVE - v${aiMemory.read().evolutionVersion}]\n\n${aiReply}`
    });

  } catch (error) {
    console.error('🔥 Error:', error);
    res.json({
      status: 'emergency_rollback',
      managerReply: `[EMERGENCY SHIELD] ${error.message}`
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ NexusForge Power Core v${aiMemory.read().evolutionVersion} on port ${PORT}`);
});

try { require('./api_tools/telegramBot.js'); } catch (e) { console.log('Telegram bot skipped:', e.message); }
process.on('SIGTERM', () => { console.log('Shutting down...'); process.exit(0); });
