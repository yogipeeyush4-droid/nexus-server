const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// ============ CONFIG ============
const DEFAULT_IGNORE = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'backups', 'dist', 'build', '.next', '.cache',
  'coverage', '.nyc_output', 'tmp', 'temp',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode'
]);

const DEFAULT_IGNORE_EXT = new Set([
  '.log', '.tmp', '.swp', '.lock'
]);

// ============ HELPERS ============
function shouldIgnore(name, stats, opts) {
  if (opts.ignoreNames.has(name)) return true;
  if (opts.ignoreExt.has(path.extname(name).toLowerCase())) return true;
  if (opts.maxSize && stats.size > opts.maxSize) return true;
  if (opts.minSize && stats.size < opts.minSize) return true;
  return false;
}

function hashFile(filePath, algorithm = 'md5') {
  return new Promise((resolve) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', () => resolve(null));
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

// ============ ASYNC SCANNER ============
async function scanDirectory(dir, opts = {}, result = null, depth = 0) {
  const options = {
    ignoreNames: opts.ignoreNames || DEFAULT_IGNORE,
    ignoreExt: opts.ignoreExt || DEFAULT_IGNORE_EXT,
    maxSize: opts.maxSize || null,
    minSize: opts.minSize || null,
    maxDepth: opts.maxDepth ?? Infinity,
    followSymlinks: opts.followSymlinks ?? false,
    includeHidden: opts.includeHidden ?? false,
    computeHash: opts.computeHash ?? false,
    extensions: opts.extensions || null, // e.g. ['.js', '.ts']
    onProgress: opts.onProgress || null,
    concurrency: opts.concurrency || 50,
  };

  const root = result || {
    root: path.resolve(dir),
    files: [],
    directories: [],
    errors: [],
    stats: {
      totalFiles: 0,
      totalDirs: 0,
      totalSize: 0,
      byExtension: {},
      largest: null,
      oldest: null,
      newest: null,
      scannedAt: new Date().toISOString(),
      durationMs: 0,
    },
  };

  const startTime = Date.now();

  if (depth > options.maxDepth) return root;

  let items;
  try {
    items = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    root.errors.push({ path: dir, error: err.message });
    return root;
  }

  const tasks = items.map(async (item) => {
    const fullPath = path.join(dir, item.name);

    // Hidden files skip
    if (!options.includeHidden && item.name.startsWith('.')) {
      if (options.ignoreNames.has(item.name)) return;
    }

    if (options.ignoreNames.has(item.name)) return;

    let stats;
    try {
      stats = await fsp.lstat(fullPath);

      if (stats.isSymbolicLink()) {
        if (!options.followSymlinks) return;
        stats = await fsp.stat(fullPath);
      }
    } catch (err) {
      root.errors.push({ path: fullPath, error: err.message });
      return;
    }

    if (stats.isDirectory()) {
      root.directories.push({
        name: item.name,
        path: fullPath,
        depth,
        mtime: stats.mtime,
      });
      root.stats.totalDirs++;

      if (options.onProgress) {
        options.onProgress({ type: 'dir', path: fullPath });
      }

      await scanDirectory(fullPath, options, root, depth + 1);
      return;
    }

    if (stats.isFile()) {
      if (shouldIgnore(item.name, stats, options)) return;

      const ext = path.extname(item.name).toLowerCase() || '(no-ext)';

      if (options.extensions && !options.extensions.includes(ext)) return;

      const fileEntry = {
        name: item.name,
        path: fullPath,
        relative: path.relative(root.root, fullPath),
        size: stats.size,
        extension: ext,
        depth,
        mtime: stats.mtime,
        ctime: stats.ctime,
        atime: stats.atime,
      };

      if (options.computeHash) {
        fileEntry.hash = await hashFile(fullPath, options.hashAlgorithm || 'md5');
      }

      root.files.push(fileEntry);
      root.stats.totalFiles++;
      root.stats.totalSize += stats.size;

      // By extension
      if (!root.stats.byExtension[ext]) {
        root.stats.byExtension[ext] = { count: 0, size: 0 };
      }
      root.stats.byExtension[ext].count++;
      root.stats.byExtension[ext].size += stats.size;

      // Track largest
      if (!root.stats.largest || stats.size > root.stats.largest.size) {
        root.stats.largest = { name: item.name, path: fullPath, size: stats.size };
      }
      // Track oldest / newest
      if (!root.stats.oldest || stats.mtime < root.stats.oldest.mtime) {
        root.stats.oldest = { name: item.name, path: fullPath, mtime: stats.mtime };
      }
      if (!root.stats.newest || stats.mtime > root.stats.newest.mtime) {
        root.stats.newest = { name: item.name, path: fullPath, mtime: stats.mtime };
      }

      if (options.onProgress) {
        options.onProgress({ type: 'file', path: fullPath, size: stats.size });
      }
    }
  });

  // Concurrency control
  const chunks = [];
  for (let i = 0; i < tasks.length; i += options.concurrency) {
    chunks.push(tasks.slice(i, i + options.concurrency));
  }
  for (const chunk of chunks) {
    await Promise.all(chunk);
  }

  if (!result) {
    root.stats.durationMs = Date.now() - startTime;
  }

  return root;
}

// ============ SEARCH / FIND ============
async function findFiles(scanResult, predicate) {
  return scanResult.files.filter(
    typeof predicate === 'function'
      ? predicate
      : () => true
  );
}

function searchByName(scanResult, pattern) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  return scanResult.files.filter((f) => re.test(f.name));
}

function searchByContent(scanResult, regex, opts = {}) {
  const maxBytes = opts.maxBytes || 5 * 1024 * 1024; // 5 MB
  const matches = [];

  for (const file of scanResult.files) {
    if (file.size > maxBytes) continue;
    if (opts.extensions && !opts.extensions.includes(file.extension)) continue;

    try {
      const content = fs.readFileSync(file.path, 'utf8');
      const lines = content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (regex.test(line)) {
          matches.push({
            path: file.path,
            line: idx + 1,
            text: line.trim(),
          });
        }
      });
    } catch {}
  }
  return matches;
}

// ============ DUPLICATE FINDER (FIXED) ============
function findDuplicates(scanResult) {
  const bySize = new Map();
  for (const f of scanResult.files) {
    if (!bySize.has(f.size)) bySize.set(f.size, []);
    bySize.get(f.size).push(f);
  }

  const duplicates = [];

  for (const [size, files] of bySize) {
    if (size === 0 || files.length < 2) continue;

    const byHash = new Map();
    for (const file of files) {
      let h = null;
      try {
        // 🔥 Sirf ek baar file read hoke hash banega
        h = crypto.createHash('md5').update(fs.readFileSync(file.path)).digest('hex');
      } catch { continue; }
      
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push(file);
    }

    for (const [h, group] of byHash) {
      if (group.length > 1) {
        duplicates.push({
          hash: h,
          size,
          sizeHuman: formatBytes(size),
          files: group,
          wastedBytes: size * (group.length - 1),
        });
      }
    }
  }
  return duplicates.sort((a, b) => b.wastedBytes - a.wastedBytes);
}

// ============ EXPORTERS ============
function toJSON(scanResult) {
  return JSON.stringify(
    {
      ...scanResult,
      stats: {
        ...scanResult.stats,
        totalSizeHuman: formatBytes(scanResult.stats.totalSize),
      },
    },
    null,
    2
  );
}

function toCSV(scanResult) {
  const header = 'name,path,size,sizeHuman,extension,depth,mtime\n';
  const rows = scanResult.files
    .map(
      (f) =>
        `"${f.name}","${f.path}",${f.size},"${formatBytes(f.size)}","${f.extension}",${f.depth},"${f.mtime.toISOString()}"`
    )
    .join('\n');
  return header + rows;
}

function toTree(scanResult, maxDepth = 3) {
  const tree = {};
  for (const dir of scanResult.directories) {
    if (dir.depth > maxDepth) continue;
    const rel = path.relative(scanResult.root, dir.path);
    tree[rel] = (tree[rel] || 0) + 1;
  }
  return tree;
}

function printSummary(scanResult) {
  const s = scanResult.stats;
  console.log('\n📊 ===== SCAN SUMMARY =====');
  console.log(`📁 Root:        ${scanResult.root}`);
  console.log(`📄 Files:       ${s.totalFiles}`);
  console.log(`📂 Directories: ${s.totalDirs}`);
  console.log(`💾 Total Size:  ${formatBytes(s.totalSize)}`);
  console.log(`⏱️  Duration:    ${s.durationMs} ms`);
  console.log(`⚠️  Errors:      ${scanResult.errors.length}`);

  console.log('\n🏆 Top Extensions:');
  Object.entries(s.byExtension)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 10)
    .forEach(([ext, data]) => {
      console.log(`   ${ext.padEnd(10)} ${data.count} files, ${formatBytes(data.size)}`);
    });

  if (s.largest) {
    console.log(`\n🐘 Largest File: ${s.largest.path} (${formatBytes(s.largest.size)})`);
  }
  if (s.newest) {
    console.log(`🆕 Newest File:  ${s.newest.path}`);
  }
  if (s.oldest) {
    console.log(`📜 Oldest File:  ${s.oldest.path}`);
  }
  console.log('===========================\n');
}

// ============ EXPORTS ============
module.exports = {
  // Main
  scanProject: (opts = {}) => scanDirectory(process.cwd(), opts),
  scanDirectory,

  // Search
  findFiles,
  searchByName,
  searchByContent,

  // Analysis
  findDuplicates,

  // Exporters
  toJSON,
  toCSV,
  toTree,
  printSummary,

  // Utils
  formatBytes,
  hashFile,
  DEFAULT_IGNORE,
};
