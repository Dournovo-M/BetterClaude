#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────
   Claude Taskboard — TUI 100 % clavier (vert/noir forcé)
   Client de l'API du serveur (server.js, http://127.0.0.1:8010).
   Fournisseur unique : Claude. Pas de souris.
   Raccourcis :
     Tab / Shift+Tab : naviguer entre les zones
     1 / 2 / 3       : aller aux colonnes Programmées / À valider / Terminées
     ↑↓ + Entrée     : ouvrir une fiche dans une colonne
     Ctrl+S          : envoyer la tâche
     Ctrl+V          : coller une image (presse-papier)
     m               : choisir le modèle
     w               : définir le dossier de travail
     Esc             : fermer un popup · Ctrl+C : quitter
   ───────────────────────────────────────────────────────────────────── */
'use strict';

const blessed = require('neo-blessed');
const { execFile } = require('child_process');
const fs = require('fs');

const API = 'http://127.0.0.1:8010';
const PROVIDER = 'claude';

/* ─── API ────────────────────────────────────────────────────────────── */
async function apiGet(p) { const r = await fetch(API + p); return r.json(); }
async function apiPost(p, body) {
  const r = await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
async function apiDelete(p) { const r = await fetch(API + p, { method: 'DELETE' }); return r.json(); }

/* ─── Presse-papier image (macOS) ───────────────────────────────────── */
function grabClipboardImage() {
  return new Promise((resolve, reject) => {
    const outPath = `/tmp/ctb-clip-${Date.now()}.png`;
    const script = [
      'try',
      '  set pngData to (the clipboard as «class PNGf»)',
      'on error',
      '  return "ERROR:no-image"',
      'end try',
      `set fileRef to open for access (POSIX file "${outPath}") with write permission`,
      'set eof fileRef to 0',
      'write pngData to fileRef',
      'close access fileRef',
      `return "${outPath}"`,
    ].join('\n');
    execFile('osascript', ['-e', script], (err, stdout) => {
      if (err) return reject(err);
      const out = String(stdout).trim();
      if (out.startsWith('ERROR')) return reject(new Error('presse-papier : pas d\'image'));
      resolve(out);
    });
  });
}

async function uploadImageFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
  return apiPost('/api/uploads', { dataUrl });
}

/* ─── Écran & thème (vert/noir forcé) ───────────────────────────────── */
const screen = blessed.screen({
  smartCSR: true,
  mouse: false,
  fullUnicode: true,
  title: 'Claude Taskboard',
  dockBorders: true,
});
screen.style = { bg: 'black', fg: 'green' };

const C = {
  border: { fg: 'green', bg: 'black' },
  text: { fg: 'green', bg: 'black' },
  bold: { fg: 'green', bold: true, bg: 'black' },
  inverse: { fg: 'black', bg: 'green', bold: true },
  focus: { border: { fg: 'white' } },
};

/* ─── Layout ─────────────────────────────────────────────────────────── */
const header = blessed.box({
  parent: screen, top: 0, left: 0, width: '100%', height: 1,
  tags: true, style: C.bold,
  content: ' {bold}⚡ CLAUDE TASKBOARD{/bold} — clavier uniquement · fournisseur : Claude',
});

const statusLine = blessed.box({
  parent: screen, top: 1, left: 0, width: '100%', height: 1,
  tags: true, style: C.text, content: ' chargement…',
});

const promptBox = blessed.textarea({
  parent: screen, top: 3, left: 1, width: '100%-2', height: 5,
  border: 'line', label: ' Prompt ',
  style: { ...C.text, border: C.border, focus: C.focus },
  inputOnFocus: true, mouse: false, keys: true, vi: false,
});

const modelBtn = blessed.box({
  parent: screen, top: 8, left: 1, width: '32%', height: 3,
  border: 'line', style: { ...C.text, border: C.border, focus: C.focus }, tags: true,
  content: '{center}Modèle (m) : défaut{/center}', mouse: false, keys: true,
});
const cwdBtn = blessed.box({
  parent: screen, top: 8, left: '35%', width: '64%', height: 3,
  border: 'line', style: { ...C.text, border: C.border, focus: C.focus }, tags: true,
  content: '{center}Dossier (w) : /{/center}', mouse: false, keys: true,
});

const imgIndicator = blessed.box({
  parent: screen, top: 11, left: 1, width: '100%-2', height: 1,
  style: C.text, tags: true, content: '',
});

const colTop = 12;
const colHeight = '100%-14';
const columns = {};
['scheduled', 'review', 'finished'].forEach((col, i) => {
  const labels = { scheduled: ' [1] PROGRAMMÉES ', review: ' [2] À VALIDER ', finished: ' [3] TERMINÉES ' };
  columns[col] = blessed.list({
    parent: screen,
    top: colTop, left: `${i * 33 + 1}%`, width: '32%', height: colHeight,
    label: labels[col], border: 'line',
    style: { ...C.text, border: C.border, selected: C.inverse, item: C.text, focus: C.focus },
    keys: false, vi: false, mouse: false, interactive: true, tags: true,
    scrollbar: { ch: '│', style: { fg: 'green' } },
  });
});

const footer = blessed.box({
  parent: screen, bottom: 0, left: 0, width: '100%', height: 1,
  tags: true, style: C.text,
  content: ' Entrée: envoyer/ouvrir · ↓: quitter le prompt · ←→ ou 1/2/3: colonnes · m: modèle · w: dossier · Ctrl+C: quitter',
});

/* ─── État local ─────────────────────────────────────────────────────── */
let state = null;
let modelsCache = null;
let pendingImages = []; // [{path, name}]
let sel = { model: '' };
let workDir = '/'; // dossier de travail — racine du PC par défaut
let taskIndex = { scheduled: [], review: [], finished: [] }; // ids alignés sur les lignes des listes

function badgeText(status) {
  const map = { queued: '○ queued', running: '● running', ok: '✓ ok', error: '✗ error', stopped: '■ stopped', validated: '✓ validée' };
  return map[status] || status;
}

function renderColumns() {
  if (!state) return;
  for (const col of ['scheduled', 'review', 'finished']) {
    const tasks = state.tasks[col];
    taskIndex[col] = tasks.map(t => t.id);
    const lines = tasks.map(t => {
      const id = t.id.slice(-4);
      const time = (t.created_at || '').slice(11, 16);
      const followups = t.followups_count ? ` +${t.followups_count}` : '';
      const prompt = (t.last_prompt || '').replace(/\n/g, ' ').slice(0, 46);
      return `#${id} ${time} ${badgeText(t.status)}${followups}\n   ${prompt}`;
    });
    columns[col].setItems(lines.length ? lines : ['  (vide)']);
  }
  screen.render();
}

function renderStatus() {
  if (!state) { statusLine.setContent(' serveur injoignable'); return; }
  const parts = [];
  parts.push(state.paused ? '{bold}● FILE EN PAUSE{/bold}' : (state.running_id ? `{bold}● RUN ACTIF{/bold} (#${state.running_id.slice(-4)})` : '● au repos'));
  parts.push(`programmées: ${state.tasks.scheduled.length}`);
  parts.push(`à valider: ${state.tasks.review.length}`);
  parts.push(`terminées: ${state.tasks.finished.length}`);
  statusLine.setContent(' ' + parts.join('   '));
}

function renderToolbar() {
  const modelLabel = sel.model ? sel.model.split('/').pop() : 'défaut';
  modelBtn.setContent(`{center}Modèle (m) : ${modelLabel}{/center}`);
  cwdBtn.setContent(`{center}Dossier (w) : ${workDir}{/center}`);
  imgIndicator.setContent(pendingImages.length ? `{green-fg}🖼 ${pendingImages.length} image(s) prête(s) — envoyées avec la tâche{/green-fg}` : '');
}

async function refresh() {
  try {
    state = await apiGet('/api/state');
    renderStatus();
    renderColumns();
    renderToolbar();
  } catch (e) {
    state = null;
    renderStatus();
  }
  screen.render();
}

async function loadModels() {
  if (modelsCache) return modelsCache;
  try { modelsCache = await apiGet(`/api/providers/${PROVIDER}/models`); }
  catch { modelsCache = []; }
  return modelsCache;
}

/* ─── Popups (sélecteurs, détails) — clavier ─────────────────────────── */
let popupOpen = false;

function openListPopup(title, items, onSelect) {
  popupOpen = true;
  const popup = blessed.list({
    parent: screen, top: 'center', left: 'center', width: '50%', height: '60%',
    label: ` ${title} — ↑↓ + Entrée · Esc ferme `, border: 'line',
    style: { ...C.text, border: { fg: 'green' }, selected: C.inverse },
    keys: true, vi: true, mouse: false, interactive: true,
    items: items.length ? items : ['(rien)'],
  });
  const close = () => { popupOpen = false; popup.destroy(); focusCurrent(); screen.render(); };
  popup.focus();
  popup.on('select', (item, i) => {
    close();
    if (items.length) onSelect(i);
  });
  popup.key(['escape', 'q'], close);
  screen.render();
}

async function openModelPicker() {
  const models = await loadModels();
  const labels = ['défaut (recommandé)', ...models.map(m => m.label)];
  openListPopup('Modèle', labels, i => {
    sel.model = i === 0 ? '' : models[i - 1].id;
    renderToolbar();
    screen.render();
  });
}

/* Mini-explorateur de fichiers (clavier) pour choisir le dossier de travail.
   ↑↓ : naviguer · Entrée sur un dossier : y descendre · Entrée sur ".." : remonter
   Entrée sur "✔ choisir" : valider le dossier courant · Esc : annuler */
function openWorkDirExplorer() {
  popupOpen = true;
  let current = (workDir && fs.existsSync(workDir)) ? workDir : '/';
  const path = require('path');

  const explorer = blessed.list({
    parent: screen, top: 'center', left: 'center', width: '70%', height: '70%',
    border: 'line', tags: true,
    style: { ...C.text, border: { fg: 'white' }, selected: C.inverse },
    keys: true, vi: true, mouse: false, interactive: true,
    scrollbar: { ch: '│', style: { fg: 'green' } },
  });

  let entries = []; // actions alignées sur les lignes : {kind:'choose'|'up'|'dir', target}
  function load(dir) {
    current = dir;
    let dirs = [];
    try {
      dirs = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => {
          if (!e.isDirectory() && !e.isSymbolicLink()) return false;
          if (e.name.startsWith('.')) return false;
          if (e.isSymbolicLink()) {
            try { return fs.statSync(path.join(dir, e.name)).isDirectory(); } catch { return false; }
          }
          return true;
        })
        .map(e => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch (err) {
      dirs = [];
    }
    entries = [{ kind: 'choose' }];
    const lines = [`{bold}[ choisir ce dossier ]{/bold}`];
    if (dir !== '/') { entries.push({ kind: 'up' }); lines.push('  ../'); }
    dirs.forEach(name => { entries.push({ kind: 'dir', target: path.join(dir, name) }); lines.push(`  ${name}/`); });
    explorer.setLabel(` Dossier de travail — ${dir} `);
    explorer.setItems(lines);
    explorer.select(0);
    screen.render();
  }

  const close = () => { popupOpen = false; explorer.destroy(); focusCurrent(); screen.render(); };
  explorer.key(['escape', 'q'], close);
  explorer.key(['C-c'], () => process.exit(0));
  explorer.key(['left'], () => { if (current !== '/') load(path.dirname(current)); });
  explorer.on('select', (item, i) => {
    const entry = entries[i];
    if (!entry) return;
    if (entry.kind === 'choose') {
      workDir = current;
      close();
      renderToolbar();
      screen.render();
    } else if (entry.kind === 'up') {
      load(path.dirname(current));
    } else {
      load(entry.target);
    }
  });

  explorer.focus();
  load(current);
}

function openTaskActions(column, task) {
  popupOpen = true;
  const lines = [];
  lines.push('{bold}Prompt :{/bold}');
  (task.last_prompt || '').split('\n').forEach(l => lines.push(l));
  if (task.last_images && task.last_images.length) lines.push(`\n🖼 ${task.last_images.length} image(s) jointe(s)`);
  if (task.followups_count) lines.push(`\n+${task.followups_count} relance(s)`);
  if (task.last_run && task.last_run.error) lines.push(`\n{bold}Erreur :{/bold}\n${task.last_run.error.slice(0, 400)}`);
  if (task.last_run && task.last_run.log_tail && task.last_run.log_tail.length) {
    lines.push('\n{bold}Journal :{/bold}');
    task.last_run.log_tail.slice(-10).forEach(e => lines.push(`${e.k === 'tool' ? '→ ' : ''}${e.s.slice(0, 100)}`));
  }
  const actions = [];
  if (column === 'review') { actions.push('✓ Valider'); actions.push('↩ Relancer…'); }
  actions.push('✕ Supprimer');
  actions.push('(fermer)');

  const detail = blessed.box({
    parent: screen, top: '8%', left: 'center', width: '70%', height: '58%',
    label: ` #${task.id.slice(-4)} — ↑↓ défile · Esc ferme `, border: 'line', tags: true, scrollable: true,
    alwaysScroll: true, mouse: false, keys: true,
    style: { ...C.text, border: { fg: 'green' } },
    content: lines.join('\n'),
  });
  const actionList = blessed.list({
    parent: screen, top: '68%', left: 'center',
    width: '70%', height: actions.length + 2, border: 'line',
    label: ' actions — ↑↓ + Entrée ', style: { ...C.text, border: { fg: 'green' }, selected: C.inverse },
    keys: true, vi: true, mouse: false, interactive: true, items: actions,
  });
  const close = () => { popupOpen = false; detail.destroy(); actionList.destroy(); focusCurrent(); screen.render(); };
  detail.key(['escape'], close);
  actionList.key(['escape', 'q'], close);
  actionList.on('select', async (item, i) => {
    const label = actions[i];
    if (label === '(fermer)') { close(); return; }
    if (label === '✓ Valider') {
      await apiPost(`/api/tasks/${task.id}/validate`, {});
      close(); await refresh();
    } else if (label === '↩ Relancer…') {
      close();
      promptFollowup(task.id);
    } else if (label === '✕ Supprimer') {
      await apiDelete(`/api/tasks/${task.id}`);
      close(); await refresh();
    }
  });
  actionList.focus();
  screen.render();
}

function promptFollowup(taskId) {
  popupOpen = true;
  const box = blessed.textarea({
    parent: screen, top: 'center', left: 'center', width: '60%', height: 7,
    label: ' Consigne complémentaire — Ctrl+S envoie, Esc annule ', border: 'line',
    style: { ...C.text, border: { fg: 'green' } }, inputOnFocus: true, mouse: false, keys: true,
  });
  const close = () => { popupOpen = false; box.destroy(); focusCurrent(); screen.render(); };
  box.key(['escape'], close);
  box.key(['C-c'], () => process.exit(0));
  box.key(['C-s'], async () => {
    const val = box.getValue().trim();
    close();
    if (!val) return;
    await apiPost(`/api/tasks/${taskId}/resend`, { prompt: val });
    await refresh();
  });
  box.focus();
  screen.render();
}

/* ─── Interactions clavier ───────────────────────────────────────────── */
modelBtn.key(['enter'], () => openModelPicker());
cwdBtn.key(['enter'], () => openWorkDirExplorer());

promptBox.key(['C-s'], () => submitTask());
// Entrée réelle = "return" dans blessed (le "enter" synthétique ré-émis par
// program.js insère déjà le \n dans le textarea, que submitTask trim).
// Maj+Entrée arrive comme "S-return"/"S-enter" : pas de binding → simple saut
// de ligne inséré par le textarea (sur les terminaux qui distinguent Maj).
promptBox.key(['return'], () => submitTask());         // Entrée envoie
// Quitter le prompt : il faut arrêter la lecture ("stop") sinon le textarea
// reprend le focus via rewindFocus() et on reste coincé dedans.
function leavePrompt(target) {
  if (promptBox._done) promptBox._done('stop');
  setImmediate(() => focusZone(target));
}
promptBox.key(['down'], () => leavePrompt(modelBtn));  // ↓ sort du prompt vers la ligne Modèle/Dossier
promptBox.key(['C-c'], () => process.exit(0));
promptBox.key(['C-v'], async () => {
  try {
    const filePath = await grabClipboardImage();
    const up = await uploadImageFile(filePath);
    pendingImages.push({ path: up.path, name: up.name });
    renderToolbar();
    screen.render();
  } catch (e) {
    statusLine.setContent(` {bold}⚠ ${e.message}{/bold}`);
    screen.render();
    setTimeout(renderStatus, 2000);
  }
});

async function submitTask() {
  const prompt = promptBox.getValue().trim();
  if (!prompt) return;
  const body = {
    prompt,
    cwd: workDir || (state ? state.default_cwd : undefined),
    images: pendingImages.map(i => i.path),
    provider: PROVIDER,
    model: sel.model,
    effort: '',
  };
  const resp = await apiPost('/api/tasks', body);
  if (resp && resp.id) {
    promptBox.clearValue();
    pendingImages = [];
    renderToolbar();
    await refresh();
    promptBox.focus();
  } else {
    statusLine.setContent(` {bold}⚠ ${resp && resp.error ? resp.error : 'échec de création'}{/bold}`);
    screen.render();
    setTimeout(renderStatus, 2500);
  }
}

/* ─── Navigation façon tableur : ↑↓←→ entre les cases ────────────────
   Ligne 1 : Prompt
   Ligne 2 : Modèle · Dossier de travail
   Ligne 3 : Programmées · À valider · Terminées
   Dans une colonne, ↑↓ parcourent les fiches ; ↑ sur la première fiche
   remonte vers la ligne Modèle/Dossier. */
function focusZone(widget) {
  if (popupOpen) return;
  focusIdx = focusOrder.indexOf(widget);
  focusCurrent();
  screen.render();
}

// Ligne 2 (Modèle / Dossier)
modelBtn.key(['right'], () => focusZone(cwdBtn));
cwdBtn.key(['left'], () => focusZone(modelBtn));
modelBtn.key(['up'], () => focusZone(promptBox));
cwdBtn.key(['up'], () => focusZone(promptBox));
modelBtn.key(['down'], () => focusZone(columns.scheduled));
cwdBtn.key(['down'], () => focusZone(columns.review));

// Ligne 3 (colonnes) : ←/→ changent de colonne, ↑ sur la 1re fiche remonte
const colOrder = ['scheduled', 'review', 'finished'];
const colUpTarget = { scheduled: modelBtn, review: cwdBtn, finished: cwdBtn };
colOrder.forEach((col, i) => {
  const list = columns[col];
  list.key(['left'], () => { if (i > 0) focusZone(columns[colOrder[i - 1]]); });
  list.key(['right'], () => { if (i < colOrder.length - 1) focusZone(columns[colOrder[i + 1]]); });
  // Gestion manuelle de ↑↓/Entrée (keys:false sur la liste) pour que ↑ sur la
  // première fiche remonte vers la ligne du dessus, comme dans un tableur.
  list.key(['up'], () => {
    if (list.selected === 0) focusZone(colUpTarget[col]);
    else { list.up(1); screen.render(); }
  });
  list.key(['down'], () => { list.down(1); screen.render(); });
  list.key(['enter'], () => list.enterSelected());
});

for (const col of ['scheduled', 'review', 'finished']) {
  columns[col].on('select', (item, i) => {
    if (!state) return;
    const id = taskIndex[col][i];
    if (!id) return;
    const task = state.tasks[col].find(t => t.id === id);
    if (task) openTaskActions(col, task);
  });
}

/* ─── Surbrillance blanche de la case active ─────────────────────────── */
const focusables = [promptBox, modelBtn, cwdBtn, columns.scheduled, columns.review, columns.finished];
focusables.forEach(w => {
  w.on('focus', () => {
    w.style.border = { fg: 'white', bg: 'black' };
    w.style.label = { fg: 'white', bold: true, bg: 'black' };
    w.style.fg = 'white';
    screen.render();
  });
  w.on('blur', () => {
    w.style.border = { fg: 'green', bg: 'black' };
    w.style.label = { fg: 'green', bg: 'black' };
    w.style.fg = 'green';
    screen.render();
  });
});

/* ─── Navigation clavier globale ─────────────────────────────────────── */
const focusOrder = [promptBox, modelBtn, cwdBtn, columns.scheduled, columns.review, columns.finished];
let focusIdx = 0;
function focusCurrent() { focusOrder[focusIdx].focus(); }
function moveFocus(delta) {
  focusIdx = (focusIdx + delta + focusOrder.length) % focusOrder.length;
  focusCurrent();
  screen.render();
}
screen.key(['tab'], () => { if (!popupOpen) moveFocus(1); });
screen.key(['S-tab'], () => { if (!popupOpen) moveFocus(-1); });
// Raccourcis directs vers les colonnes (hors popup et hors saisie du prompt)
function jumpToColumn(col) {
  if (popupOpen || screen.focused === promptBox) return;
  focusIdx = focusOrder.indexOf(columns[col]);
  focusCurrent();
  screen.render();
}
screen.key(['1'], () => jumpToColumn('scheduled'));
screen.key(['2'], () => jumpToColumn('review'));
screen.key(['3'], () => jumpToColumn('finished'));
screen.key(['m'], () => { if (!popupOpen && screen.focused !== promptBox) openModelPicker(); });
screen.key(['w'], () => { if (!popupOpen && screen.focused !== promptBox) openWorkDirExplorer(); });
screen.key(['C-c'], () => process.exit(0));

/* ─── Boot ───────────────────────────────────────────────────────────── */
(async () => {
  await refresh();
  renderToolbar();
  promptBox.focus();
  screen.render();
  setInterval(refresh, 2000);
})();
