// ── SERVICE WORKER ─────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── DB ─────────────────────────────────────────────────
const DB_NAME = 'fitnesscoach';
const DB_VER  = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('workouts')) {
        const ws = d.createObjectStore('workouts', { keyPath: 'id', autoIncrement: true });
        ws.createIndex('date', 'date');
      }
      if (!d.objectStoreNames.contains('settings')) {
        d.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror   = () => reject(req.error);
  });
}

function txStore(name, mode = 'readonly') {
  return db.transaction(name, mode).objectStore(name);
}

function dbGetAll(store) {
  return new Promise((res, rej) => {
    const req = txStore(store).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function dbPut(store, value) {
  return new Promise((res, rej) => {
    const req = txStore(store, 'readwrite').put(value);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function dbDelete(store, key) {
  return new Promise((res, rej) => {
    const req = txStore(store, 'readwrite').delete(key);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

async function getSetting(key, fallback = null) {
  return new Promise(res => {
    const req = txStore('settings').get(key);
    req.onsuccess = () => res(req.result ? req.result.value : fallback);
    req.onerror   = () => res(fallback);
  });
}

function setSetting(key, value) {
  return dbPut('settings', { key, value });
}

// ── STATE ───────────────────────────────────────────────
let exercises = null;   // loaded from exercises.json
let activeDay = 1;      // current log tab (1–4)
let sessionSets = {};   // { exerciseId: [{reps, weight, rpe}] }
let sessionCardio = []; // [{ type, minutes }]
let progressCharts = {};

// ── BOOT ────────────────────────────────────────────────
async function boot() {
  await openDB();
  exercises = await fetch('exercises.json').then(r => r.json());
  loadSettings();
  await renderHome();
  renderLog();
  renderHistory();
  renderProgress();
  setupNav();
  setupModal();
}

// ── NAV ─────────────────────────────────────────────────
function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById('view-' + view).classList.add('active');
      if (view === 'progress') refreshProgress();
      if (view === 'history') renderHistory();
    });
  });
}

// ── HOME ─────────────────────────────────────────────────
async function renderHome() {
  const now = new Date();
  document.getElementById('home-date').textContent =
    now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const workouts = await dbGetAll('workouts');
  const next = await getNextDay(workouts);
  const day = exercises.days.find(d => d.id === next);

  document.getElementById('next-workout-title').textContent = day.label;
  document.getElementById('next-workout-sub').textContent =
    `Day ${day.id} of 4 · ${day.exercises.filter(e => e.primary).length} primary exercises`;

  document.getElementById('start-workout-btn').onclick = async () => {
    activeDay = next;
    highlightDayTab();
    await initSessionForDay(activeDay);
    document.querySelector('[data-view="log"]').click();
  };

  // Week stats
  const weekStart = getWeekStart(now);
  const thisWeek  = workouts.filter(w => new Date(w.date) >= weekStart);
  const cardioMin = thisWeek.reduce((s, w) => s + (w.cardio || []).reduce((a, c) => a + c.minutes, 0), 0);
  document.getElementById('week-stats').innerHTML = `
    <div class="stat-box"><div class="stat-val">${thisWeek.length}</div><div class="stat-lbl">Workouts</div></div>
    <div class="stat-box"><div class="stat-val">${cardioMin}</div><div class="stat-lbl">Cardio min</div></div>
    <div class="stat-box"><div class="stat-val">${Math.round(cardioMin/60*10)/10}</div><div class="stat-lbl">Cardio hrs</div></div>
  `;

  // Streak
  const streak = calcStreak(workouts);
  document.getElementById('streak-display').innerHTML =
    `${streak} <span>${streak === 1 ? 'day' : 'days'}</span>`;
}

async function getNextDay(workouts) {
  // Find the last completed day; suggest next in rotation
  if (!workouts.length) return 1;
  const last = workouts.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  return (last.dayId % 4) + 1;
}

function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() - d.getDay()); // Sunday
  return d;
}

function calcStreak(workouts) {
  if (!workouts.length) return 0;
  const dates = [...new Set(workouts.map(w => w.date.slice(0,10)))].sort().reverse();
  let streak = 0;
  let check = new Date(); check.setHours(0,0,0,0);
  for (const d of dates) {
    const wDate = new Date(d);
    const diff  = Math.round((check - wDate) / 86400000);
    if (diff > 1) break;
    streak++;
    check = wDate;
  }
  return streak;
}

// ── LOG ──────────────────────────────────────────────────
function renderLog() {
  // Build day tabs
  const tabs = document.getElementById('day-tabs');
  tabs.innerHTML = '';
  exercises.days.forEach(day => {
    const btn = document.createElement('button');
    btn.className = 'day-tab' + (day.id === activeDay ? ' active' : '');
    btn.dataset.day = day.id;
    btn.textContent = `D${day.id}: ${day.label}`;
    btn.onclick = () => {
      activeDay = day.id;
      highlightDayTab();
      initSessionForDay(activeDay);
    };
    tabs.appendChild(btn);
  });

  // Cardio types
  const ct = document.getElementById('cardio-type');
  ct.innerHTML = '<option value="">Type…</option>';
  exercises.cardioTypes.forEach(t => {
    ct.innerHTML += `<option value="${t}">${t}</option>`;
  });

  document.getElementById('add-cardio-btn').onclick = addCardio;
  document.getElementById('save-workout-btn').onclick = saveWorkout;
  document.getElementById('add-alternate-btn').onclick = addAlternateExercise;

  initSessionForDay(activeDay);
}

function highlightDayTab() {
  document.querySelectorAll('.day-tab').forEach(t =>
    t.classList.toggle('active', Number(t.dataset.day) === activeDay));
}

async function initSessionForDay(dayId) {
  // Pre-fill baseline from last time this day was done
  const day = exercises.days.find(d => d.id === dayId);
  const workouts = await dbGetAll('workouts');
  const last = workouts
    .filter(w => w.dayId === dayId)
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0];

  sessionSets = {};
  day.exercises.filter(e => e.primary).forEach(ex => {
    const prevSets = last?.sets?.[ex.id] || [];
    sessionSets[ex.id] = prevSets.length
      ? prevSets.map(s => ({ ...s }))
      : [{ reps: '', weight: '', rpe: '' }];
  });

  sessionCardio = [];
  renderCardioList();
  document.getElementById('workout-notes').value = '';
  buildAlternateSelect(dayId);
  renderExerciseList();
}

function buildAlternateSelect(dayId) {
  const day = exercises.days.find(d => d.id === dayId);
  const alts = day.exercises.filter(e => !e.primary);
  const sel = document.getElementById('alternate-select');
  sel.innerHTML = '<option value="">— select —</option>';
  alts.forEach(ex => {
    if (!sessionSets[ex.id]) {
      sel.innerHTML += `<option value="${ex.id}">${ex.name}</option>`;
    }
  });
}

function addAlternateExercise() {
  const id = document.getElementById('alternate-select').value;
  if (!id) return;
  sessionSets[id] = [{ reps: '', weight: '', rpe: '' }];
  buildAlternateSelect(activeDay);
  renderExerciseList();
}

function renderExerciseList() {
  const day = exercises.days.find(d => d.id === activeDay);
  document.getElementById('log-title').textContent = `Log: ${day.label}`;
  const list = document.getElementById('exercise-list');
  list.innerHTML = '';

  Object.keys(sessionSets).forEach(exId => {
    const ex = day.exercises.find(e => e.id === exId);
    if (!ex) return;
    list.appendChild(buildExerciseCard(ex));
  });
}

function buildExerciseCard(ex) {
  const card = document.createElement('div');
  card.className = 'exercise-card';
  card.dataset.exId = ex.id;

  const sets = sessionSets[ex.id];

  card.innerHTML = `
    <div class="exercise-header">
      <img class="exercise-thumb" src="${ex.images?.[0] || ''}" alt="" loading="lazy"
           onerror="this.style.visibility='hidden'" />
      <div class="exercise-info">
        <div class="exercise-name">${ex.name}</div>
        <div class="exercise-baseline" id="baseline-${ex.id}"></div>
      </div>
      <span class="exercise-tag${ex.primary ? '' : ' alt'}">${ex.primary ? 'PRIMARY' : 'ALT'}</span>
    </div>
    <div class="exercise-body">
      <div class="sets-header">
        <span>SET</span><span>REPS</span><span>WEIGHT</span><span>RPE</span><span></span>
      </div>
      <div class="sets-container" id="sets-${ex.id}"></div>
      <button class="add-set-btn" data-ex="${ex.id}">+ Add Set</button>
      <button class="form-link" data-ex="${ex.id}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
        Form &amp; Info
      </button>
    </div>
  `;

  // Render sets
  renderSetsFor(ex.id, card);

  // Add set
  card.querySelector('.add-set-btn').onclick = () => {
    const lastSet = sessionSets[ex.id].slice(-1)[0] || {};
    sessionSets[ex.id].push({ reps: lastSet.reps || '', weight: lastSet.weight || '', rpe: '' });
    renderSetsFor(ex.id, card);
  };

  // Form modal
  card.querySelector('.form-link').onclick = e => {
    e.stopPropagation();
    openModal(ex);
  };

  // Show baseline
  loadBaseline(ex.id);

  return card;
}

function renderSetsFor(exId, card) {
  const container = card
    ? card.querySelector(`#sets-${exId}`)
    : document.querySelector(`#sets-${exId}`);
  if (!container) return;
  container.innerHTML = '';

  sessionSets[exId].forEach((set, i) => {
    const row = document.createElement('div');
    row.className = 'set-row';
    row.innerHTML = `
      <div class="set-num">${i + 1}</div>
      <input class="set-input" type="number" min="1" placeholder="—" value="${set.reps}" data-field="reps" />
      <input class="set-input" type="number" min="0" step="2.5" placeholder="lbs" value="${set.weight}" data-field="weight" />
      <input class="set-input" type="number" min="1" max="10" placeholder="—" value="${set.rpe}" data-field="rpe" />
      <button class="set-del" title="Remove set">×</button>
    `;

    row.querySelectorAll('.set-input').forEach(inp => {
      inp.oninput = () => {
        sessionSets[exId][i][inp.dataset.field] = inp.value;
      };
    });

    row.querySelector('.set-del').onclick = () => {
      sessionSets[exId].splice(i, 1);
      if (!sessionSets[exId].length) sessionSets[exId].push({ reps: '', weight: '', rpe: '' });
      renderSetsFor(exId, null);
    };

    container.appendChild(row);
  });
}

async function loadBaseline(exId) {
  const workouts = await dbGetAll('workouts');
  const last = workouts
    .filter(w => w.dayId === activeDay && w.sets?.[exId]?.length)
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0];

  const el = document.getElementById('baseline-' + exId);
  if (!el) return;
  if (!last) { el.textContent = 'No history'; return; }

  const sets = last.sets[exId];
  const dateStr = new Date(last.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  el.textContent = `Last (${dateStr}): ${sets.length}×${sets[0]?.reps} @ ${sets[0]?.weight}lbs`;
}

// ── CARDIO ───────────────────────────────────────────────
function addCardio() {
  const type = document.getElementById('cardio-type').value;
  const min  = parseInt(document.getElementById('cardio-minutes').value);
  if (!type || !min || min < 1) { showToast('Enter type and minutes', 'error'); return; }
  sessionCardio.push({ type, minutes: min });
  document.getElementById('cardio-minutes').value = '';
  renderCardioList();
}

function renderCardioList() {
  const list = document.getElementById('cardio-list');
  list.innerHTML = '';
  sessionCardio.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'cardio-item';
    div.innerHTML = `<span>${c.type} — ${c.minutes} min</span><button>×</button>`;
    div.querySelector('button').onclick = () => { sessionCardio.splice(i, 1); renderCardioList(); };
    list.appendChild(div);
  });
}

// ── SAVE WORKOUT ─────────────────────────────────────────
async function saveWorkout() {
  const hasSets = Object.values(sessionSets).some(s =>
    s.some(r => r.reps || r.weight)
  );
  if (!hasSets && !sessionCardio.length) {
    showToast('Nothing to save', 'error');
    return;
  }

  // Keep only sets that were actually filled in; drop exercises left blank
  const sets = {};
  Object.entries(sessionSets).forEach(([exId, rows]) => {
    const filled = rows.filter(r => r.reps || r.weight).map(r => ({ ...r }));
    if (filled.length) sets[exId] = filled;
  });

  const workout = {
    dayId:  activeDay,
    date:   new Date().toISOString(),
    sets,
    cardio: [...sessionCardio],
    notes:  document.getElementById('workout-notes').value.trim()
  };

  await dbPut('workouts', workout);
  showToast('Workout saved!', 'success');
  await renderHome();
  initSessionForDay(activeDay);
}

// ── HISTORY ──────────────────────────────────────────────
async function renderHistory() {
  const workouts = (await dbGetAll('workouts'))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const list = document.getElementById('history-list');
  list.innerHTML = '';

  if (!workouts.length) {
    list.innerHTML = '<p class="muted" style="text-align:center;padding:40px 0">No workouts yet</p>';
    return;
  }

  workouts.forEach(w => {
    const day = exercises.days.find(d => d.id === w.dayId);
    const cardioMin = (w.cardio || []).reduce((s, c) => s + c.minutes, 0);
    const exNames = Object.keys(w.sets || {}).map(id => {
      const ex = day?.exercises.find(e => e.id === id);
      return ex?.name || id;
    });

    const el = document.createElement('div');
    el.className = 'history-item';
    el.innerHTML = `
      <div class="history-date">${new Date(w.date).toLocaleDateString('en-US',
        { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}</div>
      <div class="history-title">Day ${w.dayId}: ${day?.label || '?'}</div>
      <div class="history-meta">
        ${exNames.length} exercise${exNames.length === 1 ? '' : 's'}
        ${cardioMin ? ` · ${cardioMin} min cardio` : ''}
        ${w.notes ? ` · "${w.notes}"` : ''}
      </div>
      <ul class="history-exercises">
        ${exNames.map(n => `<li>${n}</li>`).join('')}
        ${(w.cardio || []).map(c => `<li>${c.type} — ${c.minutes} min</li>`).join('')}
      </ul>
    `;
    list.appendChild(el);
  });
}

// ── PROGRESS ─────────────────────────────────────────────
async function renderProgress() {
  const workouts = await dbGetAll('workouts');

  // Populate exercise selector
  const sel = document.getElementById('progress-exercise-select');
  const allExIds = new Set();
  workouts.forEach(w => Object.keys(w.sets || {}).forEach(id => allExIds.add(id)));
  sel.innerHTML = '<option value="">Select exercise…</option>';
  allExIds.forEach(id => {
    const ex = exercises.days.flatMap(d => d.exercises).find(e => e.id === id);
    if (ex) sel.innerHTML += `<option value="${id}">${ex.name}</option>`;
  });
  sel.onchange = () => renderWeightChart(workouts, sel.value);

  renderWorkoutsChart(workouts);
  renderCardioChart(workouts);
}

async function refreshProgress() {
  const sel = document.getElementById('progress-exercise-select');
  const prev = sel.value;
  await renderProgress();  // rebuilds the dropdown so newly logged exercises appear
  if (prev && [...sel.options].some(o => o.value === prev)) {
    sel.value = prev;
    sel.onchange();
  }
}

function getWeekLabel(date) {
  const d = new Date(date);
  const start = getWeekStart(d);
  return start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function groupByWeek(workouts, valueFn) {
  const map = {};
  workouts.forEach(w => {
    const label = getWeekLabel(w.date);
    map[label] = (map[label] || 0) + valueFn(w);
  });
  return map;
}

function chartDefaults() {
  return {
    responsive: true,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#888', font: { size: 11 } }, grid: { color: '#2e2e2e' } },
      y: { ticks: { color: '#888', font: { size: 11 } }, grid: { color: '#2e2e2e' }, beginAtZero: true }
    }
  };
}

function renderWorkoutsChart(workouts) {
  const map = groupByWeek(workouts, () => 1);
  const labels = Object.keys(map);
  const data   = labels.map(l => map[l]);
  const ctx = document.getElementById('chart-workouts').getContext('2d');
  if (progressCharts.workouts) progressCharts.workouts.destroy();
  progressCharts.workouts = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data, backgroundColor: '#e85d04', borderRadius: 6 }]
    },
    options: chartDefaults()
  });
}

function renderCardioChart(workouts) {
  const map = groupByWeek(workouts, w =>
    (w.cardio || []).reduce((s, c) => s + c.minutes, 0)
  );
  const labels = Object.keys(map);
  const data   = labels.map(l => map[l]);
  const ctx = document.getElementById('chart-cardio').getContext('2d');
  if (progressCharts.cardio) progressCharts.cardio.destroy();
  progressCharts.cardio = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data, backgroundColor: '#ff8c42', borderRadius: 6 }]
    },
    options: chartDefaults()
  });
}

function renderWeightChart(workouts, exId) {
  if (!exId) return;
  const points = workouts
    .filter(w => w.sets?.[exId]?.length)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(w => ({
      x: new Date(w.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      y: Math.max(...w.sets[exId].map(s => parseFloat(s.weight) || 0))
    }));

  const ctx = document.getElementById('chart-weight').getContext('2d');
  if (progressCharts.weight) progressCharts.weight.destroy();
  progressCharts.weight = new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map(p => p.x),
      datasets: [{
        data: points.map(p => p.y),
        borderColor: '#e85d04',
        backgroundColor: 'rgba(232,93,4,0.15)',
        tension: 0.3,
        fill: true,
        pointBackgroundColor: '#e85d04'
      }]
    },
    options: {
      ...chartDefaults(),
      plugins: { legend: { display: false } }
    }
  });
}

// ── MODAL ────────────────────────────────────────────────
function setupModal() {
  document.getElementById('modal-close-btn').onclick = closeModal;
  document.querySelector('.modal-backdrop').onclick = closeModal;
}

function openModal(ex) {
  document.getElementById('modal-exercise-name').textContent = ex.name;
  // Two frames (start/end position) cross-fade in CSS to play like a GIF
  const [start, end] = ex.images || [];
  document.getElementById('modal-frame-0').src = start || '';
  document.getElementById('modal-frame-1').src = end || start || '';
  document.getElementById('modal-muscles').textContent =
    'Muscles: ' + ex.muscles.map(m => m.replace(/-/g, ' ')).join(', ');
  document.getElementById('modal-youtube').href = ex.youtube;
  document.getElementById('exercise-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('exercise-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

// ── SETTINGS ─────────────────────────────────────────────
async function loadSettings() {
  document.getElementById('settings-email').value           = await getSetting('email', '');
  document.getElementById('settings-emailjs-key').value     = await getSetting('emailjsKey', '');
  document.getElementById('settings-emailjs-service').value = await getSetting('emailjsService', '');
  document.getElementById('settings-emailjs-template').value= await getSetting('emailjsTemplate', '');

  ['settings-email', 'settings-emailjs-key', 'settings-emailjs-service', 'settings-emailjs-template']
    .forEach(id => {
      document.getElementById(id).onblur = saveSettings;
    });

  document.getElementById('send-recap-btn').onclick  = sendRecap;
  document.getElementById('export-btn').onclick      = exportData;
  document.getElementById('clear-data-btn').onclick  = clearData;
}

async function saveSettings() {
  await setSetting('email',           document.getElementById('settings-email').value.trim());
  await setSetting('emailjsKey',      document.getElementById('settings-emailjs-key').value.trim());
  await setSetting('emailjsService',  document.getElementById('settings-emailjs-service').value.trim());
  await setSetting('emailjsTemplate', document.getElementById('settings-emailjs-template').value.trim());
}

// ── WEEKLY RECAP ─────────────────────────────────────────
async function sendRecap() {
  await saveSettings();
  const email    = await getSetting('email');
  const pubKey   = await getSetting('emailjsKey');
  const service  = await getSetting('emailjsService');
  const template = await getSetting('emailjsTemplate');

  if (!email || !pubKey || !service || !template) {
    showToast('Fill in all email settings first', 'error');
    return;
  }

  const body = await buildRecapBody();
  document.getElementById('recap-status').textContent = 'Sending…';

  emailjs.init({ publicKey: pubKey });
  emailjs.send(service, template, {
    to_email: email,
    subject:  `FitnessCoach Weekly Recap — ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`,
    message:  body
  }).then(() => {
    document.getElementById('recap-status').textContent = 'Sent!';
    showToast('Recap sent!', 'success');
  }).catch(err => {
    document.getElementById('recap-status').textContent = 'Error — check settings';
    showToast('Email failed: ' + err.text, 'error');
  });
}

async function buildRecapBody() {
  const workouts = await dbGetAll('workouts');
  const weekStart = getWeekStart(new Date());
  const week = workouts
    .filter(w => new Date(w.date) >= weekStart)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (!week.length) return 'No workouts logged this week.';

  let body = `WEEKLY RECAP — ${weekStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}\n\n`;
  body += `Total workouts: ${week.length}\n`;

  const cardioMin = week.reduce((s, w) => s + (w.cardio || []).reduce((a, c) => a + c.minutes, 0), 0);
  if (cardioMin) body += `Total cardio: ${cardioMin} min (${Math.round(cardioMin/60*10)/10} hrs)\n`;

  body += '\n';

  week.forEach(w => {
    const day = exercises.days.find(d => d.id === w.dayId);
    body += `────────────────────────\n`;
    body += `${new Date(w.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}\n`;
    body += `Day ${w.dayId}: ${day?.label}\n\n`;

    Object.entries(w.sets || {}).forEach(([exId, sets]) => {
      const ex = day?.exercises.find(e => e.id === exId);
      body += `  ${ex?.name || exId}\n`;
      sets.forEach((s, i) => {
        if (s.reps || s.weight) {
          body += `    Set ${i+1}: ${s.reps || '?'} reps @ ${s.weight || '?'} lbs`;
          if (s.rpe) body += ` (RPE ${s.rpe})`;
          body += '\n';
        }
      });
    });

    (w.cardio || []).forEach(c => {
      body += `  Cardio: ${c.type} — ${c.minutes} min\n`;
    });

    if (w.notes) body += `  Notes: ${w.notes}\n`;
    body += '\n';
  });

  // PRs this week
  body += '════════════════════════\nNEXT WEEK BASELINES\n\n';
  week.forEach(w => {
    const day = exercises.days.find(d => d.id === w.dayId);
    body += `Day ${w.dayId}: ${day?.label}\n`;
    Object.entries(w.sets || {}).forEach(([exId, sets]) => {
      const ex   = day?.exercises.find(e => e.id === exId);
      const best = sets.reduce((b, s) => {
        const w = parseFloat(s.weight) || 0;
        return w > (parseFloat(b.weight) || 0) ? s : b;
      }, {});
      if (best.reps || best.weight) {
        body += `  ${ex?.name || exId}: ${best.reps}×${best.weight}lbs\n`;
      }
    });
    body += '\n';
  });

  return body;
}

// ── EXPORT / CLEAR ────────────────────────────────────────
async function exportData() {
  const workouts = await dbGetAll('workouts');
  const blob = new Blob([JSON.stringify(workouts, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `fitnesscoach-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function clearData() {
  if (!confirm('Delete all workout data? This cannot be undone.')) return;
  const workouts = await dbGetAll('workouts');
  for (const w of workouts) await dbDelete('workouts', w.id);
  showToast('All data cleared', 'success');
  await renderHome();
}

// ── TOAST ────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = 'toast' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}

// ── START ────────────────────────────────────────────────
boot();
