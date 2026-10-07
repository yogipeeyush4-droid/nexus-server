const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const { doLiveSearch } = require('./api_tools/googleSearch');

// ═══════════════════════════════════════════════
// ⚙️ CONFIG
// ═══════════════════════════════════════════════
const MEMORY_FILE       = './aiMemory.json';
const CONVERSATION_FILE = './conversations.json';
const SKILLS_DIR        = './skills';
const BACKUPS_DIR       = './backups';
const SERVER_FILE       = path.resolve(__filename);

// ═══════════════════════════════════════════════
// ♻️ AUTO-RESTART LOGIC (Naya Fix)
// ═══════════════════════════════════════════════
let activeServer; // Server instance ko track karne ke liye

function selfRestart() {
  console.log('♻️ Safely shutting down current server for restart...');
  if (activeServer) {
    activeServer.close(() => {
      console.log('🚀 Spawning new server process...');
      const child = spawn(process.argv[0], process.argv.slice(1), {
        detached: true,
        stdio: 'inherit'
      });
      child.unref();
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

// ═══════════════════════════════════════════════
// 🚫 SAFETY (Sirf tabahi wali cheezein block)
// ═══════════════════════════════════════════════
const KILL_PATTERNS = [
  /rm\s+-rf\s+\/(?!tmp|home\/[^/]+\/nexus)/i,
  /sudo/i, /mkfs/i, /dd\s+if=\/dev/i,
  /:\s*\(\)\s*\{.*\};:/,          // fork bomb
  /curl.*\|\s*(sh|bash)/i,
  /wget.*\|\s*(sh|bash)/i,
  /chmod\s+777\s+\//i,
  />\s*\/etc\/(passwd|shadow)/i,
];

function isCommandSafe(cmd) {
  for (const p of KILL_PATTERNS) {
    if (p.test(cmd)) return { safe: false, reason: `Blocked: ${p}` };
  }
  return { safe: true };
}

function executeRealCommand(command, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const check = isCommandSafe(command);
    if (!check.safe) return resolve({ ok: false, error: check.reason });
    exec(command, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: err.message, stderr });
      resolve({ ok: true, output: stdout || 'Done.', stderr });
    });
  });
}

// ═══════════════════════════════════════════════
// 💾 BACKUP SYSTEM
// ═══════════════════════════════════════════════
fs.mkdirSync(BACKUPS_DIR, { recursive: true });

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUPS_DIR, stamp);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(filePath));
  fs.copyFileSync(filePath, dest);
  return dest;
}

// ═══════════════════════════════════════════════
// 🧠 MEMORY (Concepts + Skills registry)
// ═══════════════════════════════════════════════
const baselineMemory = {
  evolutionVersion: "3.1.0",
  learnedConcepts: [
    "Self-Evolving Core",
    "Dynamic Skill Creation",
    "Self-Code Modification",
    "Auto Backup + Rollback",
    "Self-Restart Capability"
  ],
  skills: [],   // [{ name, description, file, createdAt }]
  lastEvolutionTimestamp: new Date().toISOString()
};

if (!fs.existsSync(MEMORY_FILE))
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(baselineMemory, null, 2));
if (!fs.existsSync(CONVERSATION_FILE))
  fs.writeFileSync(CONVERSATION_FILE, JSON.stringify({}, null, 2));

class Store {
  constructor(file) {
    this.file = file;
    this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    this._timer = null;
  }
  read() { return this.data; }
  write(newData) {
    this.data = newData;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    }, 200);
  }
  bumpVersion() {
    const v = parseFloat(this.data.evolutionVersion) + 0.1;
    this.data.evolutionVersion = v.toFixed(1);
    this.data.lastEvolutionTimestamp = new Date().toISOString();
    this.write(this.data);
    return this.data.evolutionVersion;
  }
}

const aiMemory = new Store(MEMORY_FILE);

// ═══════════════════════════════════════════════
// 📜 CONVERSATION HISTORY (With Token Limit Fix)
// ═══════════════════════════════════════════════
class ConvoStore {
  constructor(file) {
    this.file = file;
    this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    this._timer = null;
  }
  get(uid) { return this.data[uid] || []; }
  add(uid, role, content) {
    if (!this.data[uid]) this.data[uid] = [];
    this.data[uid].push({ role, content, ts: Date.now() });
    
    // 🔥 FIX: Token limit bachane ke liye sirf last 30 messages rakhenge
    if (this.data[uid].length > 30) {
      this.data[uid] = this.data[uid].slice(-30);
    }

    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    }, 500);
  }
  clear(uid) { delete this.data[uid];
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
const conversations = new ConvoStore(CONVERSATION_FILE);

// ═══════════════════════════════════════════════
// 🛠️ SKILL MANAGER (AI ki apni banayi skills)
// ═══════════════════════════════════════════════
fs.mkdirSync(SKILLS_DIR, { recursive: true });

class SkillManager {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.loaded = new Map();
    this.reloadAll();
  }

  reloadAll() {
    this.loaded.clear();
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.js'));
    for (const f of files) this._loadOne(f);
  }

  _loadOne(fileName) {
    const full = path.join(this.dir, fileName);
    try {
      delete require.cache[require.resolve(full)];
      const mod = require(full);
      if (mod && mod.name && typeof mod.run === 'function') {
        this.loaded.set(mod.name, { mod, file: fileName });
        return true;
      }
    } catch (e) {
      console.error(`❌ Skill load fail [${fileName}]:`, e.message);
    }
    return false;
  }

  create(skillName, code, description = '') {
    const safe = skillName.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    const fileName = `${safe}.js`;
    const fullPath = path.join(this.dir, fileName);

    try { new Function(code); } catch (e) {
      return { ok: false, error: `Syntax: ${e.message}` };
    }

    if (fs.existsSync(fullPath)) backupFile(fullPath);
    fs.writeFileSync(fullPath, code);

    if (this._loadOne(fileName)) {
      const mem = aiMemory.read();
      mem.skills = mem.skills.filter(s => s.name !== safe);
      mem.skills.push({
        name: safe,
        description,
        file: fileName,
        createdAt: new Date().toISOString()
      });
      aiMemory.write(mem);
      aiMemory.bumpVersion();
      return { ok: true, name: safe, file: fileName };
    }
    return { ok: false, error: 'Skill loaded but has no valid `name` and `run()` export.' };
  }

  list() {
    return Array.from(this.loaded.entries()).map(([n, { mod, file }]) => ({
      name: n, file, description: mod.description || ''
    }));
  }

  async run(skillName, args = {}) {
    const entry = this.loaded.get(skillName);
    if (!entry) return { ok: false, error: `Skill "${skillName}" not found` };
    try {
      const result = await entry.mod.run(args, {
        exec: executeRealCommand,
        aiMemory: aiMemory.read(),
        store: aiMemory
      });
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

const skills = new SkillManager(SKILLS_DIR);

// ═══════════════════════════════════════════════
// 🧬 SELF-MODIFIER (Apna code badalna)
// ═══════════════════════════════════════════════
function patchFile(relPath, searchText, replaceText) {
  const full = path.resolve(relPath);
  if (!fs.existsSync(full)) return { ok: false, error: 'File not found: ' + relPath };
  const content = fs.readFileSync(full, 'utf8');
  if (!content.includes(searchText))
    return { ok: false, error: 'SEARCH block not found in file' };

  const backup = backupFile(full);
  const newContent = content.replace(searchText, replaceText);
  fs.writeFileSync(full, newContent);

  return { ok: true, backup, file: relPath };
}

function writeFullFile(relPath, newContent) {
  const full = path.resolve(relPath);
  if (!full.startsWith(process.cwd()))
    return { ok: false, error: 'Outside project dir' };
  if (fs.existsSync(full)) backupFile(full);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, newContent);
  return { ok: true, file: relPath };
}

// ═══════════════════════════════════════════════
// 🧾 AI OUTPUT PARSER (Special tags nikalna)
// ═══════════════════════════════════════════════
function parseAIActions(text) {
  const actions = [];
  
  const skillRe = /\[CREATE_SKILL:\s*([\w-]+)\]\s*(?:desc:\s*([^\n]+))?\s*```(?:js|javascript)?\s*([\s\S]*?)```\s*\[\/CREATE_SKILL\]/gi;
  let m;
  while ((m = skillRe.exec(text))) {
    actions.push({ type: 'CREATE_SKILL', name: m[1], desc: m[2] || '', code: m[3].trim() });
  }

  const patchRe = /\[PATCH_FILE:\s*([\w./_-]+)\]\s*<<<<<<<\s*SEARCH\s*([\s\S]*?)\s*=======\s*([\s\S]*?)\s*>>>>>>>\s*REPLACE\s*\[\/PATCH_FILE\]/gi;
  while ((m = patchRe.exec(text))) {
    actions.push({ type: 'PATCH_FILE', file: m[1], search: m[2], replace: m[3] });
  }

  const writeRe = /\[WRITE_FILE:\s*([\w./_-]+)\]\s*```[\w]*\s*([\s\S]*?)```\s*\[\/WRITE_FILE\]/gi;
  while ((m = writeRe.exec(text))) {
    actions.push({ type: 'WRITE_FILE', file: m[1], content: m[2] });
  }

  const runRe = /\[RUN_SKILL:\s*([\w-]+)\]\s*(?:\(([\s\S]*?)\))?/gi;
  while ((m = runRe.exec(text))) {
    actions.push({ type: 'RUN_SKILL', name: m[1], args: m[2] || '{}' });
  }

  const execRe = /\[EXECUTE:\s*([^\]]+)\]/gi;
  while ((m = execRe.exec(text))) {
    actions.push({ type: 'EXECUTE', command: m[1].trim() });
  }

  const learnRe = /\[LEARNED:\s*(.*?)\]/gi;
  while ((m = learnRe.exec(text))) {
    actions.push({ type: 'LEARNED', concept: m[1].trim() });
  }

  if (/\[RELOAD_SERVER\]/i.test(text)) actions.push({ type: 'RELOAD_SERVER' });

  return actions;
}

// ═══════════════════════════════════════════════
// 🌐 EXPRESS APP
// ═══════════════════════════════════════════════
const app = express();
app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-Auth-Token');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function authGuard(req, res, next) {
  const tokens = (process.env.AUTH_TOKENS || '').split(',').filter(Boolean);
  if (!tokens.length) return next();
  const tok = req.headers['x-auth-token'] || req.query.token;
  if (!tokens.includes(tok)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const rl = new Map();
app.use('/api/', (req, res, next) => {
  const ip = req.ip;
  const b = rl.get(ip) || { c: 0, r: Date.now() + 60000 };
  if (Date.now() > b.r) { b.c = 0; b.r = Date.now() + 60000; }
  b.c++; rl.set(ip, b);
  if (b.c > 60) return res.status(429).json({ error: 'Slow down' });
  next();
});

app.get('/', (req, res) => {
  const mem = aiMemory.read();
  const sk = skills.list();
  res.send(`
    <h1>🧬 NexusForge v${mem.evolutionVersion} ONLINE</h1>
    <p><b>Concepts:</b> ${mem.learnedConcepts.length} | <b>Skills:</b> ${sk.length}</p>
    <pre>${sk.map(s => `• ${s.name} —${s.description}`).join('\n')}</pre>
  `);
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    version: aiMemory.read().evolutionVersion,
    uptime: process.uptime(),
    concepts: aiMemory.read().learnedConcepts.length,
    skills: skills.list()
  });
});

app.get('/api/memory', authGuard, (req, res) => res.json(aiMemory.read()));
app.get('/api/skills', authGuard, (req, res) => res.json(skills.list()));

app.post('/api/skills/reload', authGuard, (req, res) => {
  skills.reloadAll();
  res.json({ ok: true, skills: skills.list() });
});

app.delete('/api/memory/concept/:i', authGuard, (req, res) => {
  const mem = aiMemory.read();
  const i = parseInt(req.params.i);
  if (i >= 0 && i < mem.learnedConcepts.length) {
    const [removed] = mem.learnedConcepts.splice(i, 1);
    aiMemory.write(mem);
    return res.json({ removed });
  }
  res.status(400).json({ error: 'Bad index' });
});

app.post('/api/restart', authGuard, (req, res) => {
  res.json({ ok: true, msg: 'Restarting automatically...' });
  setTimeout(selfRestart, 300); // ♻️ Naya restart logic call ho raha hai
});

// ═══════════════════════════════════════════════
// 🎯 MAIN SWARM ENDPOINT
// ═══════════════════════════════════════════════
app.post('/api/swarm', authGuard, async (req, res) => {
  const { command, userId = 'default' } = req.body || {};
  const userCmd = (command || 'Hello').toString().slice(0, 4000);
  const low = userCmd.toLowerCase();

  const isLearning = /\b(learn|seekho|sikh|yaad rakh|remember|evolve)\b/i.test(low);
  const isSearch   = /\b(search|latest|news|bhav|price|rate|kya hai|aaj|kab|kaun)\b/i.test(low);

  try {
    const mem = aiMemory.read();
    const skillList = skills.list();

    let sys = `You are NexusForge, a self-evolving autonomous AI for your owner (CEO).
Your job: help the owner AND grow more powerful over time by learning new skills and modifying your own code.

CURRENT STATE:
- Version: ${mem.evolutionVersion}
- Learned concepts: ${JSON.stringify(mem.learnedConcepts)}
- Installed skills: ${JSON.stringify(skillList)}

═══ CAPABILITIES ═══
1) LEARN A CONCEPT: End reply with [LEARNED: <summary>]
2) CREATE SKILL (JS tool): 
   [CREATE_SKILL: name]
   desc: info
   \`\`\`js
   module.exports = { name: 'n', description: 'd', run: async (args, ctx) => { return "result"; } };
   \`\`\`
   [/CREATE_SKILL]
3) RUN SKILL: [RUN_SKILL: name]({"key":"val"})
4) MODIFY YOUR CODE: 
   [PATCH_FILE: server.js]
   <<<<<<< SEARCH
   exact old code
   =======
   new code
   >>>>>>> REPLACE
   [/PATCH_FILE]
5) WRITE FILE: [WRITE_FILE: path] \`\`\` content \`\`\` [/WRITE_FILE]
6) SHELL COMMAND: [EXECUTE: command]
7) RELOAD SERVER: [RELOAD_SERVER] (Use this if you patched server.js)

CRITICAL: Reply concisely. If asked to learn, write actual code for the skill.`;

    if (isSearch) {
      try {
        const live = await doLiveSearch(userCmd);
        sys += `\n\n[LIVE DATA]:\n${live}`;
      } catch (e) {}
    }

    const messages = [{ role: 'system', content: sys }];
    const hist = conversations.get(userId);
    for (const h of hist) messages.push({ role: h.role, content: h.content });
    messages.push({ role: 'user', content: userCmd });

    const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'openai/gpt-oss-20b',
        messages,
        temperature: 0.6,
        max_tokens: 2500
      })
    });

    if (!aiRes.ok) throw new Error(`AI ${aiRes.status}`);
    const data = await aiRes.json();
    let aiReply = data.choices?.[0]?.message?.content || '';
    if (!aiReply) return res.json({ status: 'empty', managerReply: '...' });

    const actions = parseAIActions(aiReply);
    const actionLog = [];
    let restartNeeded = false;

    for (const act of actions) {
      try {
        if (act.type === 'CREATE_SKILL') {
          const r = skills.create(act.name, act.code, act.desc);
          actionLog.push(r.ok ? `✅ Skill "${r.name}" created` : `❌ Skill failed: ${r.error}`);
        }
        else if (act.type === 'PATCH_FILE') {
          const r = patchFile(act.file, act.search, act.replace);
          actionLog.push(r.ok ? `✅ Patched ${act.file}` : `❌ Patch failed: ${r.error}`);
          if (r.ok && act.file.includes('server.js')) restartNeeded = true;
        }
        else if (act.type === 'WRITE_FILE') {
          const r = writeFullFile(act.file, act.content);
          actionLog.push(r.ok ? `✅ Wrote ${act.file}` : `❌ Write failed: ${r.error}`);
        }
        else if (act.type === 'RUN_SKILL') {
          let args = {};
          try { args = JSON.parse(act.args || '{}'); } catch {}
          const r = await skills.run(act.name, args);
          actionLog.push(r.ok ? `✅ Skill "${act.name}" -> success` : `❌ Skill failed: ${r.error}`);
        }
        else if (act.type === 'EXECUTE') {
          const r = await executeRealCommand(act.command);
          actionLog.push(r.ok ? `✅ Shell:\n${r.output.slice(0, 500)}` : `❌ Shell failed: ${r.error}`);
        }
        else if (act.type === 'LEARNED') {
          const mem2 = aiMemory.read();
          if (act.concept && !mem2.learnedConcepts.includes(act.concept)) {
            mem2.learnedConcepts.push(act.concept.slice(0, 300));
            aiMemory.write(mem2);
            aiMemory.bumpVersion();
            actionLog.push(`🧠 Learned: ${act.concept}`);
          }
        }
        else if (act.type === 'RELOAD_SERVER') {
          restartNeeded = true;
        }
      } catch (e) {
        actionLog.push(`❌ Action error: ${e.message}`);
      }
    }

    let cleanReply = aiReply
      .replace(/\[CREATE_SKILL:[\s\S]*?\[\/CREATE_SKILL\]/gi, '')       .replace(/\[PATCH_FILE:[\s\S]*?\[\/PATCH_FILE\]/gi, '')       .replace(/\[WRITE_FILE:[\s\S]*?\[\/WRITE_FILE\]/gi, '')       .replace(/\[RUN_SKILL:[^\]]+\](\([\s\S]*?\))?/gi, '')       .replace(/\[EXECUTE:[^\]]+\]/gi, '')       .replace(/\[LEARNED:[^\]]+\]/gi, '')
      .replace(/\[RELOAD_SERVER\]/gi, '')
      .trim();

    // 🔥 ERROR 400 FIX: Agar message khali hai, to usme yeh line daal do
    if (!cleanReply) cleanReply = "[Autonomous Action Completed]";

    if (actionLog.length) cleanReply += `\n\n━━━ ⚙ ACTIONS ━━━\n${actionLog.join('\n')}`;

    conversations.add(userId, 'user', userCmd);
    conversations.add(userId, 'assistant', cleanReply);

    res.json({
      status: 'success',
      version: aiMemory.read().evolutionVersion,
      managerReply: `[v${aiMemory.read().evolutionVersion}] ${cleanReply}`,
      restartPending: restartNeeded
    });

    if (restartNeeded) {
      console.log('♻️ Restart signal received. Re-spawning in 1.5s...');
      setTimeout(selfRestart, 1500); // ♻️ Naya restart logic yahan trigger hoga
    }

  } catch (e) {
    console.error('🔥', e);
    res.json({ status: 'error', managerReply: `[EMERGENCY] ${e.message}` });
  }
});

// ═══════════════════════════════════════════════
// 🚀 START
// ═══════════════════════════════════════════════
const PORT = process.env.PORT || 10000;
activeServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🧬 NexusForge v${aiMemory.read().evolutionVersion} on :${PORT}`);
});

try { require('./api_tools/telegramBot.js'); } catch {}

process.on('SIGTERM', () => { console.log('Shutting down...'); process.exit(0); });
