// Read-only agent tool executor (CommonJS — required by the Electron main process).
// Runs the model's <plx:read|list|search> actions against a thread's workspace
// folder. Sandboxed: every path resolves inside `cwd`; nothing is written.

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', '.cache', 'coverage', '.turbo', 'vendor', '.venv',
]);
const MAX_READ_BYTES = 200 * 1024;
const MAX_SEARCH_MATCHES = 100;
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const NUL = String.fromCharCode(0);

function resolveInside(cwd, p) {
  const target = path.resolve(cwd, p || '.');
  const rel = path.relative(cwd, target);
  if (rel === '') return target;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

function read(cwd, p) {
  const full = resolveInside(cwd, p);
  if (!full) return { status: 'error', content: 'Path is outside the workspace.' };
  try {
    const stat = fs.statSync(full);
    if (stat.isDirectory()) return { status: 'error', content: 'That path is a directory — use list instead.' };
    let content = fs.readFileSync(full, 'utf8');
    if (content.length > MAX_READ_BYTES) {
      content = content.slice(0, MAX_READ_BYTES) + `\n… [truncated at ${MAX_READ_BYTES} bytes]`;
    }
    return { status: 'ok', content };
  } catch (err) {
    return { status: 'error', content: err.code === 'ENOENT' ? 'File not found.' : String(err.message || err) };
  }
}

function list(cwd, p) {
  const full = resolveInside(cwd, p);
  if (!full) return { status: 'error', content: 'Path is outside the workspace.' };
  try {
    const entries = fs.readdirSync(full, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
      .sort((a, b) => {
        const ad = a.endsWith('/'), bd = b.endsWith('/');
        if (ad !== bd) return ad ? -1 : 1;
        return a.localeCompare(b);
      });
    return { status: 'ok', content: entries.length ? entries.join('\n') : '(empty directory)' };
  } catch (err) {
    return { status: 'error', content: err.code === 'ENOENT' ? 'Directory not found.' : String(err.message || err) };
  }
}

function search(cwd, query, p) {
  const root = resolveInside(cwd, p || '.');
  if (!root) return { status: 'error', content: 'Path is outside the workspace.' };
  let re;
  try { re = new RegExp(query, 'i'); }
  catch { return { status: 'error', content: 'Invalid search regular expression.' }; }
  const matches = [];
  let filesScanned = 0;
  const stack = [root];
  while (stack.length && matches.length < MAX_SEARCH_MATCHES && filesScanned < MAX_SEARCH_FILES) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (matches.length >= MAX_SEARCH_MATCHES) break;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      let stat;
      try { stat = fs.statSync(abs); } catch { continue; }
      if (stat.size > MAX_SEARCH_FILE_BYTES) continue;
      filesScanned++;
      let text;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      if (text.indexOf(NUL) !== -1) continue; // skip binary
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push(`${path.relative(cwd, abs)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (matches.length >= MAX_SEARCH_MATCHES) break;
        }
      }
    }
  }
  const content = matches.length
    ? matches.join('\n') + (matches.length >= MAX_SEARCH_MATCHES ? '\n… [more matches omitted]' : '')
    : 'No matches.';
  return { status: 'ok', content };
}

async function execAgentActions(cwd, actions, onProgress) {
  const listActions = Array.isArray(actions) ? actions : [];
  if (!cwd || typeof cwd !== 'string') {
    return listActions.map(() => ({
      status: 'error',
      content: 'No workspace folder is set for this thread. Ask the user to set one with the "Set folder" control.',
    }));
  }
  const results = [];
  for (let index = 0; index < listActions.length; index++) {
    const a = listActions[index];
    if (a.type === 'read') results.push(read(cwd, a.path));
    else if (a.type === 'list') results.push(list(cwd, a.path));
    else if (a.type === 'search') results.push(search(cwd, a.query, a.path));
    else if (a.type === 'run') {
      results.push(await run(cwd, a.command, (progress) => {
        if (typeof onProgress === 'function') onProgress(index, progress);
      }));
    }
    else if (a.type === 'write') results.push(write(cwd, a.path, a.content));
    else results.push({ status: 'error', content: `Unknown action: ${a.type}` });
  }
  return results;
}

const RUN_TIMEOUT_MS = 120 * 1000;
const RUN_MAX_OUTPUT = 100 * 1024;

// Run a shell command in the workspace root. Non-read: the renderer only calls
// this after the permission gate (full-access or an explicit approval).
function run(cwd, command, onProgress) {
  if (!command || typeof command !== 'string') return { status: 'error', content: 'Empty command.' };
  return new Promise((resolve) => {
    const prefix = `$ ${command}\n`;
    let stdoutText = '';
    let stderrText = '';
    let progressTimer = null;
    const progressContent = () =>
      `${prefix}${`${stdoutText}${stderrText}`.slice(0, RUN_MAX_OUTPUT)}`;
    const publishProgress = () => {
      if (typeof onProgress !== 'function') return;
      if (progressTimer) {
        clearTimeout(progressTimer);
        progressTimer = null;
      }
      onProgress({ status: 'running', content: progressContent() });
    };
    const scheduleProgress = () => {
      if (typeof onProgress !== 'function' || progressTimer) return;
      progressTimer = setTimeout(publishProgress, 32);
    };

    const child = exec(command, {
      cwd,
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      stdoutText = String(stdout || stdoutText);
      stderrText = String(stderr || stderrText);
      publishProgress();
      if (!err) {
        const text = stdoutText.slice(0, RUN_MAX_OUTPUT) || '(no output)';
        resolve({ status: 'ok', content: `$ ${command}\n${text}\n[exit 0]` });
        return;
      }
      const code = typeof err.code === 'number' ? err.code : (err.signal ? `signal ${err.signal}` : 1);
      const body = `${stdoutText}${stderrText || String(err.message || '')}`.slice(0, RUN_MAX_OUTPUT) || '(no output)';
      resolve({ status: 'error', content: `$ ${command}\n${body}\n[exit ${code}]` });
    });
    publishProgress();
    child.stdout?.on('data', (chunk) => {
      stdoutText += String(chunk);
      scheduleProgress();
    });
    child.stderr?.on('data', (chunk) => {
      stderrText += String(chunk);
      scheduleProgress();
    });
  });
}

// Write (create or overwrite) a file with the given full contents. Returns a
// unified `diff` (old → new) for the UI to render; the `content` fed back to the
// model stays a short confirmation so we don't burn tokens echoing the file.
function write(cwd, p, content) {
  const full = resolveInside(cwd, p);
  if (!full) return { status: 'error', content: 'Path is outside the workspace.' };
  try {
    let oldContent = null;
    try {
      const stat = fs.statSync(full);
      if (stat.isDirectory()) return { status: 'error', content: 'That path is a directory.' };
      oldContent = fs.readFileSync(full, 'utf8');
    } catch (_) { oldContent = null; } // new file
    const next = content ?? '';
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, next, 'utf8');
    const bytes = Buffer.byteLength(next, 'utf8');
    const isNew = oldContent === null;
    const diff = unifiedDiff(p, oldContent ?? '', next, isNew);
    const confirm = isNew ? `Created ${p} (${bytes} bytes).` : `Wrote ${p} (${bytes} bytes).`;
    return { status: 'ok', content: confirm, diff };
  } catch (err) {
    return { status: 'error', content: String(err.message || err) };
  }
}

// Line-based unified diff via an LCS. No external deps (the main process is
// CommonJS with no bundler). Output is a git-style hunk the renderer colorizes.
function unifiedDiff(relPath, oldStr, newStr, isNew) {
  if (isNew) {
    const lines = newStr.length ? newStr.replace(/\n$/, '').split('\n') : [];
    const header = `--- /dev/null\n+++ b/${relPath}`;
    const body = lines.map((l) => `+${l}`).join('\n');
    return lines.length ? `${header}\n${body}` : `${header}\n(empty file)`;
  }
  if (oldStr === newStr) return `--- a/${relPath}\n+++ b/${relPath}\n(no changes — file content is identical)`;

  const a = oldStr.replace(/\n$/, '').split('\n');
  const b = newStr.replace(/\n$/, '').split('\n');
  const MAX = 4000; // cap the LCS table to keep big rewrites fast
  if (a.length > MAX || b.length > MAX) {
    return `--- a/${relPath}\n+++ b/${relPath}\n@@ file replaced (${a.length} → ${b.length} lines) @@`;
  }

  // LCS length table.
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Walk the table into an edit script, then group into +/-/context runs.
  const ops = []; // { t: ' '|'-'|'+', line }
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { ops.push({ t: ' ', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', line: a[i] }); i++; }
    else { ops.push({ t: '+', line: b[j] }); j++; }
  }
  while (i < m) { ops.push({ t: '-', line: a[i] }); i++; }
  while (j < n) { ops.push({ t: '+', line: b[j] }); j++; }

  // Emit hunks with up to 3 lines of surrounding context around each change.
  const CTX = 3;
  const changed = ops.map((o) => o.t !== ' ');
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (changed[k]) {
      for (let d = -CTX; d <= CTX; d++) {
        const idx = k + d;
        if (idx >= 0 && idx < ops.length) keep[idx] = true;
      }
    }
  }
  const out = [`--- a/${relPath}`, `+++ b/${relPath}`];
  let oldLn = 1, newLn = 1;
  let hunk = null; // { oldStart, newStart, lines: [] }
  const flush = () => {
    if (!hunk) return;
    const oldCount = hunk.lines.filter((l) => l[0] === ' ' || l[0] === '-').length;
    const newCount = hunk.lines.filter((l) => l[0] === ' ' || l[0] === '+').length;
    out.push(`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`);
    out.push(...hunk.lines);
    hunk = null;
  };
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k];
    if (keep[k]) {
      if (!hunk) hunk = { oldStart: oldLn, newStart: newLn, lines: [] };
      hunk.lines.push(o.t + o.line);
    } else if (hunk) {
      flush();
    }
    if (o.t === ' ') { oldLn++; newLn++; }
    else if (o.t === '-') { oldLn++; }
    else { newLn++; }
  }
  flush();
  return out.join('\n');
}

module.exports = { execAgentActions };
