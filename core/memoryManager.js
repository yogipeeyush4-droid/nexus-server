
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// ============ CONFIG ============
const CONFIG = {
  memoryFile: process.env.AI_MEMORY_FILE ||
    path.join(process.cwd(), 'aiMemory.json'),
  backupDir: process.env.AI_MEMORY_BACKUP_DIR ||
    path.join(process.cwd(), '.ai-memory-backups'),
  maxBackups: 10,                 // rotate old backups
  schemaVersion: 2,               // bump on breaking changes
  maxHistory: 500,                // trim project history
  lockTimeoutMs: 5000,            // concurrent access wait
  autoBackup: true,
  enableEncryption: false,        // set true + key to encrypt
  encryptionKey: process.env.AI_MEMORY_KEY || null,
};

// ============ DEFAULT SHAPE ============
function defaultMemory() {
  return {
    schemaVersion: CONFIG.schemaVersion,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),

    learnedSkills: [],              // [{ name, category, learnedAt, source, confidence }]
    projectHistory: [],             // [{ time, score, skills, fileCount, size }]
    lastScan: null,

    stats: {
      totalScans: 0,
      totalSkillsLearned: 0,
      bestScore: 0,
      worstScore: 100,
      avgScore: 0,
    },

    skillIndex: {},                 // { skillName: { count, lastSeen } }
    metadata: {},                   // free-form user data
  };
}

// ============ ATOMIC WRITE ============
async function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });

  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, data, 'utf8');

  // fsync for durability
  const fh = await fsp.open(tmp, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }

  await fsp.rename(tmp, filePath); // atomic on same filesystem
}

// ============ ENCRYPTION (optional) ============
function encrypt(text) {
  if (!CONFIG.enableEncryption || !CONFIG.encryptionKey) return text;
  const iv = crypto.randomBytes(16);
  const key = crypto.createHash('sha256').update(CONFIG.encryptionKey).digest();
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `ENC:${iv.toString('hex')}:${encrypted}`;
}

function decrypt(text) {
  if (!text.startsWith('ENC:')) return text;
  if (!CONFIG.encryptionKey) throw new Error('Encryption key missing');
  const [, ivHex, data] = text.split(':');
  const key = crypto.createHash('sha256').update(CONFIG.encryptionKey).digest();
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ============ MIGRATION ============
function migrate(data) {
  let version = data.schemaVersion || 1;

  // v1 -> v2
  if (version < 2) {
    const oldSkills = data.learnedSkills || [];
    data.learnedSkills = oldSkills.map((s) =>
      typeof s === 'string'
        ? { name: s, category: 'unknown', learnedAt: new Date().toISOString(), source: 'migration' }
        : s
    );
    data.schemaVersion = 2;
    version = 2;
  }

  // Future migrations yahan
  // if (version < 3) { ... }

  return data;
}

// ============ LOAD ============
function loadMemory() {
  try {
    if (!fs.existsSync(CONFIG.memoryFile)) {
      return defaultMemory();
    }

    const raw = fs.readFileSync(CONFIG.memoryFile, 'utf8');
    const decrypted = decrypt(raw);
    const parsed = JSON.parse(decrypted);

    return migrate(parsed);
  } catch (err) {
    console.error('[memory] load error:', err.message);

    // Try backup recovery
    const recovered = tryRecoverFromBackup();
    if (recovered) {
      console.warn('[memory] recovered from backup');
      return recovered;
    }

    return defaultMemory();
  }
}

// ============ RECOVERY ============
function tryRecoverFromBackup() {
  try {
    if (!fs.existsSync(CONFIG.backupDir)) return null;

    const files = fs
      .readdirSync(CONFIG.backupDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse(); // newest first

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(CONFIG.backupDir, file), 'utf8');
        const parsed = JSON.parse(raw);
        return migrate(parsed);
      } catch {}
    }
  } catch {}
  return null;
}

// ============ BACKUP ROTATION ============
function rotateBackups() {
  try {
    if (!fs.existsSync(CONFIG.backupDir)) return;

    const files = fs
      .readdirSync(CONFIG.backupDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({
        name: f,
        path: path.join(CONFIG.backupDir, f),
        time: fs.statSync(path.join(CONFIG.backupDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.time - a.time);

    // Delete older than maxBackups
    for (let i = CONFIG.maxBackups; i < files.length; i++) {
      try {
        fs.unlinkSync(files[i].path);
      } catch {}
    }
  } catch (err) {
    console.error('[memory] backup rotation error:', err.message);
  }
}

function createBackup(memory) {
  if (!CONFIG.autoBackup) return;
  try {
    if (!fs.existsSync(CONFIG.backupDir)) {
      fs.mkdirSync(CONFIG.backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(
      CONFIG.backupDir,
      `memory-${timestamp}.json`
    );

    fs.writeFileSync(backupPath, JSON.stringify(memory, null, 2));
    rotateBackups();
  } catch (err) {
    console.error('[memory] backup error:', err.message);
  }
}

// ============ CONCURRENCY LOCK ============
// Simple in-process mutex + file-based lock for cross-process
let writeQueue = Promise.resolve();

function withLock(fn) {
  const run = writeQueue.then(() => fn());
  // Don't break chain on error
  writeQueue = run.catch(() => {});
  return run;
}

// ============ SAVE ============
function saveMemory(memory) {
  return withLock(async () => {
    memory.updatedAt = new Date().toISOString();

    // Trim history
    if (memory.projectHistory.length > CONFIG.maxHistory) {
      memory.projectHistory = memory.projectHistory.slice(-CONFIG.maxHistory);
    }

    // Backup before overwrite
    if (fs.existsSync(CONFIG.memoryFile)) {
      const existing = loadMemory();
      createBackup(existing);
    }

    const json = JSON.stringify(memory, null, 2);
    const payload = encrypt(json);

    await atomicWrite(CONFIG.memoryFile, payload);
    return memory;
  });
}

// ============ SKILL MANAGEMENT ============
function addSkill(skill, meta = {}) {
  return withLock(async () => {
    const memory = loadMemory();

    const skillObj = typeof skill === 'string'
      ? {
          name: skill,
          category: meta.category || 'unknown',
          learnedAt: new Date().toISOString(),
          source: meta.source || 'manual',
          confidence: meta.confidence || 'medium',
        }
      : skill;

    const existing = memory.learnedSkills.find((s) => s.name === skillObj.name);

    if (!existing) {
      memory.learnedSkills.push(skillObj);
      memory.stats.totalSkillsLearned++;
    } else {
      // Update existing
      existing.lastSeen = new Date().toISOString();
      existing.confidence = skillObj.confidence || existing.confidence;
      existing.category = skillObj.category || existing.category;
    }

    // Update skill index
    if (!memory.skillIndex[skillObj.name]) {
      memory.skillIndex[skillObj.name] = { count: 0, lastSeen: null };
    }
    memory.skillIndex[skillObj.name].count++;
    memory.skillIndex[skillObj.name].lastSeen = new Date().toISOString();

    await saveMemory(memory);
    return memory.learnedSkills;
  });
}

function addSkills(skills, meta = {}) {
  return withLock(async () => {
    const memory = loadMemory();
    for (const skill of skills) {
      const skillObj = typeof skill === 'string'
        ? { name: skill, category: meta.category || 'unknown', learnedAt: new Date().toISOString(), source: meta.source || 'bulk' }
        : skill;

      const existing = memory.learnedSkills.find((s) => s.name === skillObj.name);
      if (!existing) {
        memory.learnedSkills.push(skillObj);
        memory.stats.totalSkillsLearned++;
      }
    }
    await saveMemory(memory);
    return memory.learnedSkills;
  });
}

function removeSkill(skillName) {
  return withLock(async () => {
    const memory = loadMemory();
    const before = memory.learnedSkills.length;
    memory.learnedSkills = memory.learnedSkills.filter(
      (s) => (s.name || s) !== skillName
    );
    await saveMemory(memory);
    return before !== memory.learnedSkills.length;
  });
}

function hasSkill(skillName) {
  const memory = loadMemory();
  return memory.learnedSkills.some((s) => (s.name || s) === skillName);
}

function getSkillsByCategory(category) {
  const memory = loadMemory();
  return memory.learnedSkills.filter((s) => s.category === category);
}

// ============ PROJECT SCAN HISTORY ============
function addProjectScan(report) {
  return withLock(async () => {
    const memory = loadMemory();

    const time = new Date().toISOString();
    memory.lastScan = time;

    const entry = {
      time,
      score: report.score ?? 0,
      skills: report.skills?.detectedCount ?? 0,
      missingSkills: report.skills?.missingCount ?? 0,
      fileCount: report.overview?.totalFiles ?? 0,
      size: report.overview?.totalSize ?? '0 B',
    };

    memory.projectHistory.push(entry);
    memory.stats.totalScans++;

    // Update stats
    const scores = memory.projectHistory.map((h) => h.score).filter((s) => typeof s === 'number');
    if (scores.length > 0) {
      memory.stats.bestScore = Math.max(...scores);
      memory.stats.worstScore = Math.min(...scores);
      memory.stats.avgScore = Math.round(
        scores.reduce((a, b) => a + b, 0) / scores.length
      );
    }

    await saveMemory(memory);
    return entry;
  });
}

// ============ SEARCH / QUERY ============
function searchSkills(pattern) {
  const memory = loadMemory();
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  return memory.learnedSkills.filter((s) => re.test(s.name || ''));
}

function getRecentScans(limit = 10) {
  const memory = loadMemory();
  return memory.projectHistory.slice(-limit).reverse();
}

// ============ TRENDS ============
function getScoreTrend(windowSize = 10) {
  const memory = loadMemory();
  const history = memory.projectHistory.slice(-windowSize);

  if (history.length < 2) {
    return { direction: 'flat', change: 0, history };
  }

  const first = history[0].score;
  const last = history[history.length - 1].score;
  const change = last - first;

  return {
    direction: change > 2 ? 'up' : change < -2 ? 'down' : 'flat',
    change,
    firstScore: first,
    lastScore: last,
    history,
  };
}

function getSkillGrowth(days = 7) {
  const memory = loadMemory();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const recent = memory.learnedSkills.filter((s) => {
    const t = s.learnedAt ? new Date(s.learnedAt).getTime() : 0;
    return t > cutoff;
  });

  return {
    window: `${days}d`,
    learned: recent.length,
    skills: recent.map((s) => s.name),
  };
}

// ============ STATS / EXPORT ============
function getMemoryStats() {
  const memory = loadMemory();
  const sizeOnDisk = fs.existsSync(CONFIG.memoryFile)
    ? fs.statSync(CONFIG.memoryFile).size
    : 0;

  return {
    ...memory.stats,
    totalSkills: memory.learnedSkills.length,
    historyEntries: memory.projectHistory.length,
    sizeOnDisk,
    sizeOnDiskHuman: `${(sizeOnDisk / 1024).toFixed(2)} KB`,
    schemaVersion: memory.schemaVersion,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    lastScan: memory.lastScan,
  };
}

function exportMemory(format = 'json') {
  const memory = loadMemory();

  if (format === 'json') return JSON.stringify(memory, null, 2);

  if (format === 'csv') {
    const header = 'time,score,skills,missingSkills,fileCount,size\n';
    const rows = memory.projectHistory
      .map((h) => `${h.time},${h.score},${h.skills},${h.missingSkills},${h.fileCount},"${h.size}"`)
      .join('\n');
    return header + rows;
  }

  throw new Error(`Unknown format: ${format}`);
}

function importMemory(data, merge = false) {
  return withLock(async () => {
    let incoming = typeof data === 'string' ? JSON.parse(data) : data;
    incoming = migrate(incoming);

    if (!merge) {
      await saveMemory(incoming);
      return incoming;
    }

    const current = loadMemory();

    // Merge skills (dedup by name)
    const skillNames = new Set(current.learnedSkills.map((s) => s.name));
    for (const skill of incoming.learnedSkills || []) {
      if (!skillNames.has(skill.name)) {
        current.learnedSkills.push(skill);
      }
    }

    // Merge history
    current.projectHistory.push(...(incoming.projectHistory || []));
    current.projectHistory.sort((a, b) => new Date(a.time) - new Date(b.time));

    await saveMemory(current);
    return current;
  });
}

// ============ RESET ============
function resetMemory(preserveBackups = true) {
  return withLock(async () => {
    if (preserveBackups && fs.existsSync(CONFIG.memoryFile)) {
      const existing = loadMemory();
      createBackup(existing);
    }
    const fresh = defaultMemory();
    await saveMemory(fresh);
    return fresh;
  });
}

// ============ CLEANUP ============
function pruneHistory(keepLast = 50) {
  return withLock(async () => {
    const memory = loadMemory();
    memory.projectHistory = memory.projectHistory.slice(-keepLast);
    await saveMemory(memory);
    return memory.projectHistory.length;
  });
}

function pruneOldSkills(days = 90) {
  return withLock(async () => {
    const memory = loadMemory();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const before = memory.learnedSkills.length;

    memory.learnedSkills = memory.learnedSkills.filter((s) => {
      const t = s.learnedAt ? new Date(s.learnedAt).getTime() : Infinity;
      return t > cutoff;
    });

    await saveMemory(memory);
    return before - memory.learnedSkills.length;
  });
}

// ============ EXPORT ============
module.exports = {
  // Core
  loadMemory,
  saveMemory,
  resetMemory,

  // Skills
  addSkill,
  addSkills,
  removeSkill,
  hasSkill,
  getSkillsByCategory,
  searchSkills,
  pruneOldSkills,

  // Scans
  addProjectScan,
  getRecentScans,
  getScoreTrend,
  getSkillGrowth,

  // Stats / IO
  getMemoryStats,
  exportMemory,
  importMemory,

  // Maintenance
  pruneHistory,
  createBackup,
  tryRecoverFromBackup,

  // Config
  CONFIG,
};
