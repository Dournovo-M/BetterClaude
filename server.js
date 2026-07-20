#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────
   Claude Taskboard — file de tâches locale pour Claude Code CLI
   Démarrage : node server.js  →  http://localhost:8010

   ⚠ Les tâches tournent avec --dangerously-skip-permissions.
     Le serveur n'écoute QUE sur 127.0.0.1 — ne jamais exposer.

   Modèle : 3 dossiers = 3 états. Chaque tâche est un fichier .txt
   (contenu JSON) qui se déplace entre les dossiers :
     tasks/scheduled/           → en attente / en cours
     tasks/waiting-for-review/  → terminée, à valider
     tasks/finished/            → validée
   Le runner lance UNE tâche à la fois, en FIFO, dès qu'aucun
   process n'est en cours (relance --resume si session connue).
   ───────────────────────────────────────────────────────────────────── */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 8010;
const ROOT = __dirname;
const DIRS = {
  scheduled: path.join(ROOT, 'tasks', 'scheduled'),
  review:    path.join(ROOT, 'tasks', 'waiting-for-review'),
  finished:  path.join(ROOT, 'tasks', 'finished'),
};
const UPLOADS_DIR = path.join(ROOT, 'tasks', 'uploads');
// Dossier de travail par défaut des tâches — surchargez avec TASKBOARD_CWD.
const DEFAULT_CWD = process.env.TASKBOARD_CWD || require('os').homedir();
const CLAUDE_BIN = 'claude';
const OPENCODE_BIN = 'opencode';
// Fournisseurs — claude tourne en direct (CLI officiel), tous les autres
// passent par opencode (qui donne accès à OpenRouter : codex/gemini/kimi/
// glm/grok) ou à ses propres modèles locaux/gratuits (opencode/*, ollama/*…).
const PROVIDERS = {
  claude:   { label: 'Claude',   engine: 'claude' },
  codex:    { label: 'Codex',    engine: 'opencode', prefix: 'openrouter/openai/',     default: 'openrouter/openai/gpt-5.3-codex' },
  gemini:   { label: 'Gemini',   engine: 'opencode', prefix: 'openrouter/google/',     default: 'openrouter/~google/gemini-pro-latest' },
  kimi:     { label: 'Kimi',     engine: 'opencode', prefix: 'openrouter/moonshotai/', default: 'openrouter/~moonshotai/kimi-latest' },
  glm:      { label: 'GLM',      engine: 'opencode', prefix: 'openrouter/z-ai/',       default: 'openrouter/z-ai/glm-5.2' },
  grok:     { label: 'Grok',     engine: 'opencode', prefix: 'openrouter/x-ai/',       default: 'openrouter/~x-ai/grok-latest' },
  opencode: { label: 'OpenCode', engine: 'opencode', prefix: '',                       default: 'opencode/big-pickle' },
};
const TASK_TIMEOUT_MS = 60 * 60 * 1000; // garde-fou : 1 h max par run
const POLL_MS = 2000;
const LOG_MAX_ENTRIES = 500;
const LOG_MAX_CHARS = 2000;
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // 10 Mo par image
const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const MODELS_CACHE_MS = 10 * 60 * 1000; // `opencode models` liste ~360 entrées, pas besoin de la re-fetch à chaque clic
let modelsCache = { at: 0, list: null };

// Liste brute de tous les modèles connus d'opencode (1 seul appel, mis en cache)
function fetchAllModels() {
  return new Promise(resolve => {
    if (modelsCache.list && Date.now() - modelsCache.at < MODELS_CACHE_MS) {
      return resolve(modelsCache.list);
    }
    const proc = spawn(OPENCODE_BIN, ['models'], { env: process.env });
    let out = '';
    proc.stdout.on('data', c => { out += c; });
    proc.on('error', () => resolve(modelsCache.list || []));
    proc.on('close', () => {
      const list = out.split('\n').map(l => l.trim()).filter(Boolean);
      modelsCache = { at: Date.now(), list };
      resolve(list);
    });
  });
}

// Modèles disponibles pour un fournisseur donné (filtrés par préfixe, nom court pour l'affichage)
async function modelsForProvider(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return [];
  if (p.engine === 'claude') {
    return [
      { id: '', label: 'défaut (sonnet)' },
      { id: 'opus', label: 'opus' },
      { id: 'haiku', label: 'haiku' },
    ];
  }
  const all = await fetchAllModels();
  const prefix = p.prefix || '';
  return all
    // Le fournisseur "opencode" générique = tout SAUF les modèles déjà
    // accessibles via un bouton dédié (openrouter/* = codex/gemini/kimi/glm/grok)
    .filter(m => prefix ? m.startsWith(prefix) : !m.startsWith('openrouter/'))
    .map(m => ({ id: m, label: m.slice(prefix.length) || m }));
}

Object.values(DIRS).forEach(d => fs.mkdirSync(d, { recursive: true }));
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/* ─── Persistance des tâches ───────────────────────────────────────── */

function taskPath(dir, id) { return path.join(dir, id + '.txt'); }

function readTask(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function writeTask(dir, task) {
  fs.writeFileSync(taskPath(dir, task.id), JSON.stringify(task, null, 2));
}

function listTasks(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.txt'))
    .sort() // les noms commencent par l'epoch ms → ordre FIFO
    .map(f => readTask(path.join(dir, f)))
    .filter(Boolean);
}

// Retrouve une tâche dans n'importe quelle colonne
function findTask(id) {
  for (const [key, dir] of Object.entries(DIRS)) {
    const file = taskPath(dir, id);
    if (fs.existsSync(file)) {
      const task = readTask(file);
      if (task) return { key, dir, file, task };
    }
  }
  return null;
}

function moveTask(fromDir, toDir, task) {
  writeTask(fromDir, task);
  fs.renameSync(taskPath(fromDir, task.id), taskPath(toDir, task.id));
}

/* ─── Runner — une tâche à la fois ─────────────────────────────────── */

let current = null;   // { id, proc, timeout }
let paused = false;

setInterval(() => {
  if (paused || current) return;
  const next = listTasks(DIRS.scheduled).find(t => t.status === 'queued');
  if (next) runTask(next).catch(err => console.error('[runner]', err));
}, POLL_MS);

function pushLog(task, kind, text) {
  task.runs[task.runs.length - 1].log.push({
    k: kind,
    s: String(text).slice(0, LOG_MAX_CHARS),
    at: new Date().toISOString(),
  });
  const log = task.runs[task.runs.length - 1].log;
  if (log.length > LOG_MAX_ENTRIES) log.splice(0, log.length - LOG_MAX_ENTRIES);
}

// Ajoute la liste des images jointes en texte (Claude Code les lit via l'outil Read)
function imagesBlock(images) {
  if (!images || !images.length) return '';
  return '\n\n[Images jointes — utilise l\'outil Read sur ces chemins pour les visualiser]\n' +
    images.map(p => `- ${p}`).join('\n');
}

// Prompt combiné (fallback quand --resume échoue) : original + relances
function combinedPrompt(task) {
  let p = task.original_prompt + imagesBlock(task.original_images);
  task.followups.forEach((f, i) => {
    p += `\n\n[Consigne complémentaire ${i + 1} — la tâche a déjà été tentée, voir consignes précédentes]\n${f.prompt}` + imagesBlock(f.images);
  });
  return p;
}

async function runTask(task) {
  const run = {
    started_at: new Date().toISOString(),
    ended_at: null,
    resumed: false,
    log: [],
    result: null,
    error: null,
    cost_usd: null,
    duration_ms: null,
    exit_code: null,
  };
  task.runs.push(run);
  task.status = 'running';
  writeTask(DIRS.scheduled, task);

  const lastFollowup = task.followups[task.followups.length - 1];
  const canResume = Boolean(task.session_id && lastFollowup);

  let outcome = await execProvider(task, {
    prompt: canResume
      ? lastFollowup.prompt + imagesBlock(lastFollowup.images)
      : (lastFollowup ? combinedPrompt(task) : task.original_prompt + imagesBlock(task.original_images)),
    resume: canResume ? task.session_id : null,
  });

  // --resume peut échouer (session purgée) → un seul retry, prompt combiné
  if (!outcome.ok && outcome.resumed && !outcome.gotResult && !outcome.stopped) {
    pushLog(task, 'info', 'Reprise de session impossible — relance avec le prompt combiné.');
    outcome = await execProvider(task, { prompt: combinedPrompt(task), resume: null });
  }

  run.ended_at = new Date().toISOString();
  task.status = outcome.stopped ? 'stopped' : (outcome.ok ? 'ok' : 'error');

  moveTask(DIRS.scheduled, DIRS.review, task);
  current = null;
}

// Route vers l'engine du fournisseur choisi (claude par défaut, rétro-compatible
// avec les tâches créées avant l'existence du multi-fournisseur).
function execProvider(task, opts) {
  const providerId = task.provider && PROVIDERS[task.provider] ? task.provider : 'claude';
  const provider = PROVIDERS[providerId];
  if (provider.engine === 'opencode') return execOpencode(task, opts, provider);
  return execClaude(task, opts);
}

function resolveModel(task, provider) {
  return (task.model && task.model.trim()) || provider.default || undefined;
}

// Lance opencode (codex/gemini/kimi/glm/grok via OpenRouter, ou ses modèles
// propres) et parse son flux JSONL — schéma différent de celui de claude.
function execOpencode(task, { prompt, resume }, provider) {
  return new Promise(resolve => {
    const run = task.runs[task.runs.length - 1];
    run.resumed = Boolean(resume);

    const model = resolveModel(task, provider);
    const args = ['run', prompt, '--format', 'json', '--dangerously-skip-permissions'];
    if (model) args.push('--model', model);
    if (task.effort) args.push('--variant', task.effort);
    if (resume) args.push('--session', resume);

    const cwd = task.cwd && fs.existsSync(task.cwd) ? task.cwd : DEFAULT_CWD;
    pushLog(task, 'info', `Lancement (${provider.label}${model ? ' — ' + model : ''}) dans ${cwd}${resume ? ' (reprise de session)' : ''}`);

    const proc = spawn(OPENCODE_BIN, args, { cwd, env: process.env });
    let stopped = false;
    const timeout = setTimeout(() => {
      run.error = 'Timeout (1 h) — process interrompu.';
      proc.kill('SIGTERM');
    }, TASK_TIMEOUT_MS);
    current = {
      id: task.id,
      proc,
      timeout,
      stop() { stopped = true; run.error = 'Interrompue manuellement.'; proc.kill('SIGTERM'); },
    };

    let dirty = false;
    const flusher = setInterval(() => {
      if (dirty) { dirty = false; try { writeTask(DIRS.scheduled, task); } catch {} }
    }, 1000);

    let gotResult = false;
    let isError = false;
    let stdoutBuf = '';
    let stderrBuf = '';
    let lastText = null;
    let totalCost = 0;

    proc.stdout.on('data', chunk => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        handleEvent(ev);
        dirty = true;
      }
    });
    proc.stderr.on('data', chunk => { stderrBuf += chunk; });

    function handleEvent(ev) {
      if (ev.sessionID) task.session_id = ev.sessionID;
      const part = ev.part || {};
      if (ev.type === 'text' && part.text && part.text.trim()) {
        lastText = part.text.trim();
        pushLog(task, 'text', lastText);
      } else if (ev.type === 'tool_use' && part.type === 'tool') {
        const title = part.state && part.state.title ? part.state.title : (part.tool || 'tool');
        pushLog(task, 'tool', `${part.tool || '?'} — ${title}`);
      } else if (ev.type === 'step_finish') {
        gotResult = true;
        if (part.cost) totalCost += part.cost;
        if (part.reason === 'stop') {
          run.result = lastText || run.result;
          run.cost_usd = totalCost || null;
        }
      } else if (ev.type === 'error') {
        isError = true;
        const msg = (ev.error && (ev.error.data?.message || ev.error.name)) || 'erreur opencode';
        if (!run.error) run.error = msg;
        pushLog(task, 'info', `⚠ ${msg}`);
      }
    }

    proc.on('error', err => {
      clearTimeout(timeout);
      clearInterval(flusher);
      run.error = `Impossible de lancer ${OPENCODE_BIN} : ${err.message}`;
      resolve({ ok: false, resumed: Boolean(resume), gotResult: false, stopped: false });
    });

    proc.on('close', code => {
      clearTimeout(timeout);
      clearInterval(flusher);
      run.exit_code = code;
      if (!gotResult && !run.error) {
        run.error = `Process terminé sans résultat (code ${code}).` +
          (stderrBuf.trim() ? `\nstderr : ${stderrBuf.trim().slice(0, 1500)}` : '');
      }
      const ok = gotResult && !isError && code === 0 && !stopped;
      resolve({ ok, resumed: Boolean(resume), gotResult, stopped });
    });
  });
}

function execClaude(task, { prompt, resume }) {
  return new Promise(resolve => {
    const run = task.runs[task.runs.length - 1];
    run.resumed = Boolean(resume);

    const args = [];
    if (resume) args.push('--resume', resume);
    args.push('-p', prompt,
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose');

    const cwd = task.cwd && fs.existsSync(task.cwd) ? task.cwd : DEFAULT_CWD;
    pushLog(task, 'info', `Lancement dans ${cwd}${resume ? ' (reprise de session)' : ''}`);

    const proc = spawn(CLAUDE_BIN, args, { cwd, env: process.env });
    let stopped = false;
    const timeout = setTimeout(() => {
      run.error = 'Timeout (1 h) — process interrompu.';
      proc.kill('SIGTERM');
    }, TASK_TIMEOUT_MS);
    current = {
      id: task.id,
      proc,
      timeout,
      stop() { stopped = true; run.error = 'Interrompue manuellement.'; proc.kill('SIGTERM'); },
    };

    // Flush périodique pour que l'UI voie le log en direct
    let dirty = false;
    const flusher = setInterval(() => {
      if (dirty) { dirty = false; try { writeTask(DIRS.scheduled, task); } catch {} }
    }, 1000);

    let gotResult = false;
    let isError = false;
    let stdoutBuf = '';
    let stderrBuf = '';

    proc.stdout.on('data', chunk => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        handleEvent(ev);
        dirty = true;
      }
    });
    proc.stderr.on('data', chunk => { stderrBuf += chunk; });

    function shortToolInput(name, input) {
      if (!input) return '';
      if (input.command) return input.description || input.command;
      if (input.file_path) return input.file_path;
      if (input.pattern) return input.pattern;
      try { return JSON.stringify(input).slice(0, 120); } catch { return ''; }
    }

    function handleEvent(ev) {
      if (ev.type === 'system' && ev.subtype === 'init') {
        pushLog(task, 'info', `Session ${ev.session_id} — modèle ${ev.model || '?'}`);
      } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text.trim()) pushLog(task, 'text', block.text.trim());
          else if (block.type === 'tool_use') pushLog(task, 'tool', `${block.name} — ${shortToolInput(block.name, block.input)}`);
        }
      } else if (ev.type === 'result') {
        gotResult = true;
        isError = Boolean(ev.is_error);
        run.result = ev.result || run.result;
        run.cost_usd = ev.total_cost_usd ?? null;
        run.duration_ms = ev.duration_ms ?? null;
        if (ev.session_id) task.session_id = ev.session_id;
        if (isError && !run.error) run.error = ev.result || `Résultat en erreur (${ev.subtype || '?'})`;
      }
    }

    proc.on('error', err => {
      // ex. binaire claude introuvable
      clearTimeout(timeout);
      clearInterval(flusher);
      run.error = `Impossible de lancer ${CLAUDE_BIN} : ${err.message}`;
      resolve({ ok: false, resumed: Boolean(resume), gotResult: false, stopped: false });
    });

    proc.on('close', code => {
      clearTimeout(timeout);
      clearInterval(flusher);
      run.exit_code = code;
      if (!gotResult && !run.error) {
        run.error = `Process terminé sans résultat (code ${code}).` +
          (stderrBuf.trim() ? `\nstderr : ${stderrBuf.trim().slice(0, 1500)}` : '');
      }
      const ok = gotResult && !isError && code === 0 && !stopped;
      resolve({ ok, resumed: Boolean(resume), gotResult, stopped });
    });
  });
}

/* ─── API HTTP ─────────────────────────────────────────────────────── */

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > maxBytes) { reject(new Error('body trop grand')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
  });
}

// Valide qu'un chemin d'image référencé par une tâche pointe bien dans tasks/uploads/
function validUploadPath(p) {
  if (typeof p !== 'string' || !p) return false;
  const resolved = path.resolve(p);
  return resolved.startsWith(UPLOADS_DIR + path.sep) && fs.existsSync(resolved);
}

// Résumé compact d'une tâche pour la liste (sans les logs complets)
function summarize(task) {
  const lastRun = task.runs[task.runs.length - 1] || null;
  const lastFollowup = task.followups[task.followups.length - 1];
  return {
    id: task.id,
    created_at: task.created_at,
    cwd: task.cwd,
    status: task.status,
    provider: task.provider || 'claude',
    model: task.model || '',
    effort: task.effort || '',
    original_prompt: task.original_prompt,
    original_images: (task.original_images || []).map(p => path.basename(p)),
    followups_count: task.followups.length,
    last_prompt: lastFollowup ? lastFollowup.prompt : task.original_prompt,
    last_images: (lastFollowup ? lastFollowup.images : task.original_images || []).map(p => path.basename(p)),
    runs_count: task.runs.length,
    last_run: lastRun && {
      started_at: lastRun.started_at,
      ended_at: lastRun.ended_at,
      error: lastRun.error,
      cost_usd: lastRun.cost_usd,
      duration_ms: lastRun.duration_ms,
      result_preview: lastRun.result ? lastRun.result.slice(0, 300) : null,
      log_tail: lastRun.log.slice(-8),
    },
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean); // ex. ['api','tasks',':id','validate']

  try {
    /* Pas d'interface web — le serveur n'expose que l'API JSON (client : la TUI). */
    if (req.method === 'GET' && url.pathname === '/') {
      json(res, 200, { name: 'better-claude', ui: 'run ./cli.sh', api: '/api/state' });
      return;
    }

    /* Liste des fournisseurs disponibles */
    if (req.method === 'GET' && url.pathname === '/api/providers') {
      json(res, 200, Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label })));
      return;
    }

    /* Modèles disponibles pour un fournisseur */
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'providers' && parts[2] && parts[3] === 'models') {
      if (!PROVIDERS[parts[2]]) return json(res, 404, { error: 'Fournisseur inconnu.' });
      const models = await modelsForProvider(parts[2]);
      json(res, 200, models);
      return;
    }

    /* État global (polling UI) */
    if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, {
        paused,
        running_id: current ? current.id : null,
        default_cwd: DEFAULT_CWD,
        tasks: {
          scheduled: listTasks(DIRS.scheduled).map(summarize),
          review: listTasks(DIRS.review).map(summarize),
          finished: listTasks(DIRS.finished).map(summarize),
        },
      });
      return;
    }

    /* Uploader une image (jointe à un prompt ou une relance) */
    if (req.method === 'POST' && url.pathname === '/api/uploads') {
      const body = await readBody(req, UPLOAD_MAX_BYTES * 1.4); // marge pour l'encodage base64
      const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(body.dataUrl || '');
      if (!m) return json(res, 422, { error: 'Image invalide (dataUrl attendue).' });
      const ext = MIME_EXT[m[1]];
      if (!ext) return json(res, 422, { error: `Type d'image non supporté : ${m[1]}` });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > UPLOAD_MAX_BYTES) return json(res, 413, { error: 'Image trop lourde (max 10 Mo).' });
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const filePath = path.join(UPLOADS_DIR, name);
      fs.writeFileSync(filePath, buf);
      return json(res, 201, { path: filePath, name, url: `/api/uploads/file/${name}` });
    }

    /* Servir une image uploadée (prévisualisation UI) */
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'uploads' && parts[2] === 'file' && parts[3]) {
      const name = path.basename(parts[3]);
      const filePath = path.join(UPLOADS_DIR, name);
      if (!fs.existsSync(filePath)) return json(res, 404, { error: 'Image introuvable.' });
      const ext = path.extname(name).toLowerCase();
      const mime = Object.entries(MIME_EXT).find(([, e]) => e === ext);
      res.writeHead(200, { 'Content-Type': mime ? mime[0] : 'application/octet-stream' });
      res.end(fs.readFileSync(filePath));
      return;
    }

    /* Créer une tâche */
    if (req.method === 'POST' && url.pathname === '/api/tasks') {
      const body = await readBody(req);
      const prompt = (body.prompt || '').trim();
      if (!prompt) return json(res, 422, { error: 'Prompt vide.' });
      const cwd = (body.cwd || '').trim() || DEFAULT_CWD;
      if (!fs.existsSync(cwd)) return json(res, 422, { error: `Répertoire introuvable : ${cwd}` });
      const images = Array.isArray(body.images) ? body.images.filter(validUploadPath) : [];
      const provider = PROVIDERS[body.provider] ? body.provider : 'claude';
      const task = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        created_at: new Date().toISOString(),
        cwd,
        provider,
        model: (body.model || '').trim(),
        effort: (body.effort || '').trim(),
        original_prompt: prompt,
        original_images: images,
        followups: [],
        runs: [],
        session_id: null,
        status: 'queued',
      };
      writeTask(DIRS.scheduled, task);
      return json(res, 201, summarize(task));
    }

    /* Détail complet d'une tâche */
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'tasks' && parts[2] && !parts[3]) {
      const found = findTask(parts[2]);
      if (!found) return json(res, 404, { error: 'Tâche introuvable.' });
      return json(res, 200, { column: found.key, task: found.task });
    }

    /* Valider (review → finished) */
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'tasks' && parts[3] === 'validate') {
      const found = findTask(parts[2]);
      if (!found || found.key !== 'review') return json(res, 409, { error: 'La tâche doit être en attente de review.' });
      found.task.status = 'validated';
      found.task.validated_at = new Date().toISOString();
      moveTask(found.dir, DIRS.finished, found.task);
      return json(res, 200, { ok: true });
    }

    /* Relancer avec un prompt complémentaire (review → scheduled) */
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'tasks' && parts[3] === 'resend') {
      const found = findTask(parts[2]);
      if (!found || found.key !== 'review') return json(res, 409, { error: 'La tâche doit être en attente de review.' });
      const body = await readBody(req);
      const prompt = (body.prompt || '').trim();
      if (!prompt) return json(res, 422, { error: 'Prompt complémentaire vide.' });
      const images = Array.isArray(body.images) ? body.images.filter(validUploadPath) : [];
      found.task.followups.push({ prompt, images, at: new Date().toISOString() });
      found.task.status = 'queued';
      moveTask(found.dir, DIRS.scheduled, found.task);
      return json(res, 200, { ok: true });
    }

    /* Stopper la tâche en cours */
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      if (!current) return json(res, 409, { error: 'Aucune tâche en cours.' });
      current.stop();
      return json(res, 200, { ok: true });
    }

    /* Pause / reprise de la file */
    if (req.method === 'POST' && url.pathname === '/api/queue/toggle') {
      paused = !paused;
      return json(res, 200, { paused });
    }

    /* Supprimer une tâche */
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'tasks' && parts[2]) {
      const found = findTask(parts[2]);
      if (!found) return json(res, 404, { error: 'Tâche introuvable.' });
      if (current && current.id === parts[2]) return json(res, 409, { error: 'Tâche en cours — stoppe-la d\'abord.' });
      fs.unlinkSync(found.file);
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'Route inconnue.' });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

// Au boot : une tâche restée "running" après un crash redevient "queued"
for (const t of listTasks(DIRS.scheduled)) {
  if (t.status === 'running') { t.status = 'queued'; writeTask(DIRS.scheduled, t); }
}

process.on('SIGINT', () => {
  if (current) current.proc.kill('SIGTERM');
  process.exit(0);
});

server.listen(PORT, HOST, () => {
  console.log(`⚡ Claude Taskboard — http://localhost:${PORT}`);
  console.log(`   Tâches : ${path.join(ROOT, 'tasks')}`);
  console.log(`   ⚠ Runs en --dangerously-skip-permissions (écoute 127.0.0.1 uniquement)`);
});
