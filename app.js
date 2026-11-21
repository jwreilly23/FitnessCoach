// ── SERVICE WORKER ─────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
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
let logDate = localDateStr(); // 'YYYY-MM-DD' (local) the workout is logged for
let logDatePicked = false;
let editingWorkout = null;    // saved workout being edited, or null when logging a new one    // true once the user picks a date other than today

// ── DATE HELPERS ────────────────────────────────────────
// Local calendar date as 'YYYY-MM-DD' (toISOString would give the UTC date)
function localDateStr(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseLocalDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Workouts logged on or before the selected log date, so backlogging an
// older day pre-fills from what came before it rather than from later sessions
function workoutsUpToLogDate(workouts) {
  return workouts.filter(w => localDateStr(new Date(w.date)) <= logDate);
}

// ── BOOT ────────────────────────────────────────────────
async function boot() {
  await openDB();
  exercises = await fetch('exercises.json').then(r => r.json());
  await migrateCardioTypes();
  loadSettings();
  await renderHome();
  renderLog();
  renderHistory();
  renderProgress();
  setupNav();
  setupModal();
  setupRangeToggle();
}

// Cardio minutes never exceed Active Zone Minutes when Fitbit AZM is known,
// so long low-effort sessions (a 4-hour hike with 45 AZM) don't skew cardio
// totals. The full duration is kept as fitbitMinutes for display.
function capCardioToAzm(c) {
  if (c.azm == null) return false;
  const full = c.fitbitMinutes ?? c.minutes;
  const capped = Math.min(full, c.azm);
  if (c.minutes === capped && (full === capped || c.fitbitMinutes === full)) return false;
  if (full > capped) c.fitbitMinutes = full;
  c.minutes = capped;
  return true;
}

// Data fixes run on load:
// - outdoor cycling was always lawn mowing
// - Fitbit cardio minutes capped at AZM
// - Fitbit-imported walk/hike entries below the workout bar are removed
//   (only standalone entries that contain nothing else)
async function migrateCardioTypes() {
  const renames = { 'Cycling (outdoor)': 'Lawn Mowing' };
  for (const w of await dbGetAll('workouts')) {
    const cardio = w.cardio || [];
    const weakWalkOnly = !hasLifting(w) && !w.fitbit && !w.notes && cardio.length &&
      cardio.every(c => c.fitbitId && c.type === 'Walk/Hike' && !walkCounts(c.fitbitMinutes ?? c.minutes, c.azm));
    if (weakWalkOnly) { await dbDelete('workouts', w.id); continue; }
    let changed = false;
    (w.cardio || []).forEach(c => {
      if (renames[c.type]) { c.type = renames[c.type]; changed = true; }
      if (capCardioToAzm(c)) changed = true;
    });
    if (changed) await dbPut('workouts', w);
  }
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
      if (view === 'log' && !logDatePicked && logDate !== localDateStr()) {
        setLogDate(localDateStr()); // app left open past midnight
      }
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
    setLogDate(localDateStr(), false);
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
    <div class="stat-box"><div class="stat-val">${Object.values(groupByDate(thisWeek)).filter(isWorkoutDay).length}</div><div class="stat-lbl">Workout days</div></div>
    <div class="stat-box"><div class="stat-val">${cardioMin}</div><div class="stat-lbl">Cardio min</div></div>
    <div class="stat-box"><div class="stat-val">${Math.round(cardioMin/60*10)/10}</div><div class="stat-lbl">Cardio hrs</div></div>
  `;

  // Streak
  const streak = calcStreak(workouts);
  document.getElementById('streak-display').innerHTML =
    `${streak} <span>${streak === 1 ? 'day' : 'days'}</span>`;
}

// A saved entry with lifting sets (cardio-only entries don't count as a training day)
const hasLifting = w => Object.keys(w.sets || {}).length > 0;
// Any lifting session: logged sets, or a lifting session imported from Fitbit
const isLiftWorkout = w => hasLifting(w) || !!w.fitbit?.isLift;

function workoutTitle(w) {
  const day = exercises.days.find(d => d.id === w.dayId);
  if (isLiftWorkout(w)) return day ? `Day ${day.id}: ${day.label}` : 'Weightlifting (Fitbit)';
  return 'Cardio';
}

async function getNextDay(workouts) {
  workouts = workouts.filter(w => isLiftWorkout(w) && w.dayId);
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

  // Date picker: defaults to today, can be moved back to backlog a past day
  const dateInput = document.getElementById('log-date');
  dateInput.onchange = () => {
    const today = localDateStr();
    let val = dateInput.value || today;
    if (val > today) val = today; // no logging in the future
    logDatePicked = val !== today;
    setLogDate(val);
  };
  document.getElementById('log-today-btn').onclick = () => {
    logDatePicked = false;
    setLogDate(localDateStr());
  };
  updateLogDateUI();

  document.getElementById('add-cardio-btn').onclick = addCardio;
  document.getElementById('fitbit-check-btn').onclick = checkFitbit;
  document.getElementById('save-workout-btn').onclick = saveWorkout;
  document.getElementById('log-new-btn').onclick = () => initSessionForDay(activeDay, { fresh: true });
  document.getElementById('add-alternate-btn').onclick = addAlternateExercise;

  initSessionForDay(activeDay);
}

// Change the log date and reload pre-filled baselines for it
function setLogDate(dateStr, reload = true) {
  logDate = dateStr;
  if (dateStr === localDateStr()) logDatePicked = false;
  updateLogDateUI();
  if (reload) initSessionForDay(activeDay);
}

function updateLogDateUI() {
  const today = localDateStr();
  const input = document.getElementById('log-date');
  input.max   = today;
  input.value = logDate;
  const isToday = logDate === today;
  document.getElementById('log-today-btn').classList.toggle('hidden', isToday);
  const note = document.getElementById('log-date-note');
  note.classList.toggle('hidden', isToday);
  if (!isToday) {
    note.textContent = 'Backlogging: ' + parseLocalDate(logDate).toLocaleDateString('en-US',
      { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }
}

function highlightDayTab() {
  document.querySelectorAll('.day-tab').forEach(t =>
    t.classList.toggle('active', Number(t.dataset.day) === activeDay));
}

const sameDate = w => localDateStr(new Date(w.date)) === logDate;

// Load the form for a day. If this day was already logged on the selected date,
// open that entry for editing; otherwise (or with fresh) start a new log
// pre-filled from the last time this day was done.
async function initSessionForDay(dayId, { fresh = false } = {}) {
  const day = exercises.days.find(d => d.id === dayId);
  const all = await dbGetAll('workouts');
  const byNewest = (a, b) => new Date(b.date) - new Date(a.date);

  editingWorkout = fresh ? null
    : all.filter(w => w.dayId === dayId && sameDate(w)).sort(byNewest)[0] || null;

  sessionSets = {};
  if (editingWorkout) {
    Object.entries(editingWorkout.sets || {}).forEach(([exId, rows]) => {
      sessionSets[exId] = rows.map(r => ({ ...r }));
    });
    sessionCardio = (editingWorkout.cardio || []).map(c => ({ ...c }));
    document.getElementById('workout-notes').value = editingWorkout.notes || '';
  } else {
    const last = workoutsUpToLogDate(all).filter(w => w.dayId === dayId).sort(byNewest)[0];
    day.exercises.filter(e => e.primary).forEach(ex => {
      const prevSets = last?.sets?.[ex.id] || [];
      sessionSets[ex.id] = prevSets.length
        ? prevSets.map(s => ({ ...s }))
        : [{ reps: '', weight: '', rpe: '' }];
    });
    sessionCardio = [];
    document.getElementById('workout-notes').value = '';
  }

  renderCardioList();
  document.getElementById('fitbit-list').innerHTML = ''; // results belong to the previous date/day
  updateSaveButtons();
  buildAlternateSelect(dayId);
  renderExerciseList();
}

function updateSaveButtons() {
  const editing = !!editingWorkout;
  document.getElementById('save-workout-btn').textContent = editing ? 'Update Workout' : 'Save Workout';
  document.getElementById('log-new-btn').classList.toggle('hidden', !editing);
  const note = document.getElementById('log-edit-note');
  note.classList.toggle('hidden', !editing);
  if (editing) {
    const when = new Date(editingWorkout.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    note.textContent = `Editing the workout already logged for ${when}`;
  }
}

// Any exercise for this day that isn't on the form yet (primaries first)
function buildAlternateSelect(dayId) {
  const day = exercises.days.find(d => d.id === dayId);
  const sel = document.getElementById('alternate-select');
  sel.innerHTML = '<option value="">— select —</option>';
  [...day.exercises].sort((a, b) => b.primary - a.primary).forEach(ex => {
    if (!sessionSets[ex.id]) {
      sel.innerHTML += `<option value="${ex.id}">${ex.name}${ex.primary ? '' : ' (alt)'}</option>`;
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
      <button class="exercise-remove" title="Remove exercise" aria-label="Remove ${ex.name}">×</button>
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

  // Remove exercise from this workout (can be re-added from the Add Exercise list)
  card.querySelector('.exercise-remove').onclick = () => {
    delete sessionSets[ex.id];
    buildAlternateSelect(activeDay);
    renderExerciseList();
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
  const workouts = workoutsUpToLogDate(await dbGetAll('workouts'))
    .filter(w => w.id !== editingWorkout?.id); // don't compare an entry to itself
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
    div.querySelector('button').onclick = () => {
      sessionCardio.splice(i, 1);
      renderCardioList();
      if (document.querySelector('.fitbit-item')) renderFitbitList();
    };
    list.appendChild(div);
  });
}

// ── FITBIT (Google Health API) ───────────────────────────
// Reads Fitbit-recorded exercise sessions for the selected log date so they
// can be added as cardio in one tap. Sign-in uses Google's browser token flow
// (no server): an access token lasts about an hour, then Google asks again.
const FITBIT = {
  clientId: '32159203608-v1u4lc1j6c4lg4306omusfa1sn5kr770.apps.googleusercontent.com',
  scope:    'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  api:      'https://health.googleapis.com/v4/users/me/dataTypes'
};

// Fitbit exercise type -> this app's cardio type
const FITBIT_CARDIO_MAP = {
  TREADMILL: 'Treadmill', TREADMILL_WALK: 'Treadmill', INCLINE_WALK: 'Treadmill', INCLINE_RUN: 'Treadmill',
  STAIRCLIMBER: 'Stairmaster',
  ELLIPTICAL: 'Elliptical',
  ROWING_MACHINE: 'Rowing Machine',
  STATIONARY_BIKE: 'Stationary Bike', SPINNING: 'Stationary Bike', ASSAULT_BIKE: 'Stationary Bike',
  RUNNING: 'Running (outdoor)', TRAIL_RUN: 'Running (outdoor)',
  // Fitbit auto-detects mowing as biking (Jack doesn't bike outdoors), so these are mowing
  BIKING: 'Lawn Mowing', OUTDOOR_BIKE: 'Lawn Mowing', MOUNTAIN_BIKE: 'Lawn Mowing', ELECTRIC_BIKE: 'Lawn Mowing',
  MOWING_LAWN: 'Lawn Mowing',
  WALKING: 'Walk/Hike', HIKING: 'Walk/Hike', POWER_WALKING: 'Walk/Hike', NORDIC_WALKING: 'Walk/Hike',
  BACKPACKING: 'Walk/Hike', RUCKING: 'Walk/Hike', WALK_WITH_WEIGHTS: 'Walk/Hike',
  SWIMMING: 'Swimming', SWIMMING_POOL: 'Swimming', SWIMMING_OPEN_WATER: 'Swimming',
  JUMPING_ROPE: 'Jump Rope'
};
// Lifting sessions are already logged as sets, so they aren't offered as cardio
const FITBIT_LIFT_TYPES = new Set(['WEIGHTS', 'WEIGHTLIFTING', 'STRENGTH_TRAINING', 'FREE_WEIGHTS',
  'WEIGHT_MACHINES', 'POWERLIFTING', 'FUNCTIONAL_STRENGTH_TRAINING', 'CORE_TRAINING', 'BODY_WEIGHT',
  'CALISTHENICS', 'CIRCUIT_TRAINING', 'CROSSFIT', 'RESISTANCE_BANDS', 'TRX']);

let fitbitToken = null; // { value, expires }
try { fitbitToken = JSON.parse(sessionStorage.getItem('fitbitToken')); } catch {}
let fitbitSessions = [];

// Must be called straight from a tap (no await before it) so the sign-in popup isn't blocked
function getFitbitToken() {
  if (fitbitToken && fitbitToken.expires > Date.now() + 60000) return Promise.resolve(fitbitToken.value);
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      reject(new Error('Google sign-in didn\'t load. Check your connection and try again.'));
      return;
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: FITBIT.clientId,
      scope: FITBIT.scope,
      callback: resp => {
        if (resp.error || !resp.access_token) {
          reject(new Error('Sign-in was cancelled or failed (' + (resp.error || 'no token') + ').'));
          return;
        }
        fitbitToken = { value: resp.access_token, expires: Date.now() + (resp.expires_in || 3600) * 1000 };
        try { sessionStorage.setItem('fitbitToken', JSON.stringify(fitbitToken)); } catch {}
        resolve(fitbitToken.value);
      },
      error_callback: err => reject(new Error('Sign-in window closed or blocked (' + (err?.type || 'error') + ').'))
    });
    client.requestAccessToken({ prompt: '' });
  });
}

async function fetchFitbitSessions(dateStr, token) {
  const next = parseLocalDate(dateStr);
  next.setDate(next.getDate() + 1);
  const filter = `exercise.interval.civil_start_time >= "${dateStr}" AND ` +
                 `exercise.interval.civil_start_time < "${localDateStr(next)}"`;
  const url = `${FITBIT.api}/exercise/dataPoints?pageSize=25&filter=${encodeURIComponent(filter)}`;
  const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (resp.status === 401) {
    fitbitToken = null;
    try { sessionStorage.removeItem('fitbitToken'); } catch {}
    throw new Error('Google sign-in expired. Tap again to sign back in.');
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json()).error?.message || ''; } catch {}
    throw new Error(`Fitbit request failed (${resp.status}). ${detail}`);
  }
  const data = await resp.json();
  return (data.dataPoints || [])
    .filter(dp => dp.exercise)
    .sort((a, b) => new Date(a.exercise.interval.startTime) - new Date(b.exercise.interval.startTime));
}

function checkFitbit() {
  const list = document.getElementById('fitbit-list');
  const forDate = logDate;
  list.innerHTML = '<p class="muted">Checking Fitbit…</p>';
  getFitbitToken()
    .then(token => fetchFitbitSessions(forDate, token))
    .then(sessions => {
      if (forDate !== logDate) return; // date changed while loading
      fitbitSessions = sessions;
      renderFitbitList();
    })
    .catch(err => {
      list.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'muted fitbit-error';
      p.textContent = err.message;
      list.appendChild(p);
    });
}

function fitbitSessionInfo(dp) {
  const ex = dp.exercise;
  const start = new Date(ex.interval.startTime);
  const activeSec = parseFloat(ex.activeDuration);
  const minutes = Math.max(1, Math.round(activeSec > 0
    ? activeSec / 60
    : (new Date(ex.interval.endTime) - start) / 60000));
  const m = ex.metricsSummary || {};
  return {
    id: dp.name || ex.interval.startTime,
    name: ex.displayName || ex.exerciseType,
    cardioType: FITBIT_CARDIO_MAP[ex.exerciseType] || 'Other',
    isLift: FITBIT_LIFT_TYPES.has(ex.exerciseType),
    minutes,
    time: start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    calories: m.caloriesKcal ? Math.round(m.caloriesKcal) : null,
    avgHr: m.averageHeartRateBeatsPerMinute ? Number(m.averageHeartRateBeatsPerMinute) : null,
    azm: m.activeZoneMinutes ? Number(m.activeZoneMinutes) : null,
    exerciseType: ex.exerciseType,
    startTime: ex.interval.startTime
  };
}

function renderFitbitList() {
  const list = document.getElementById('fitbit-list');
  list.innerHTML = '';
  if (!fitbitSessions.length) {
    list.innerHTML = '<p class="muted">No Fitbit workouts recorded on this day.</p>';
    return;
  }
  fitbitSessions.forEach(dp => {
    const s = fitbitSessionInfo(dp);
    const added = sessionCardio.some(c => c.fitbitId === s.id);
    const row = document.createElement('div');
    row.className = 'fitbit-item';
    const details = [s.time, `${s.minutes} min`,
      s.calories != null ? `${s.calories} cal` : '',
      s.avgHr != null ? `${s.avgHr} bpm avg` : '',
      s.azm != null ? `${s.azm} AZM` : ''].filter(Boolean).join(' · ');
    row.innerHTML = `
      <div class="fitbit-info">
        <div class="fitbit-name"></div>
        <div class="fitbit-meta"></div>
      </div>`;
    row.querySelector('.fitbit-name').textContent =
      s.name + (s.isLift ? ' (lifting)' : s.cardioType !== s.name ? ` → ${s.cardioType}` : '');
    row.querySelector('.fitbit-meta').textContent = details;
    if (!s.isLift) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary fitbit-add';
      btn.textContent = added ? 'Added ✓' : 'Add';
      btn.disabled = added;
      btn.onclick = () => {
        const entry = { type: s.cardioType, minutes: s.minutes, fitbitId: s.id,
                        azm: s.azm, avgHr: s.avgHr, calories: s.calories };
        capCardioToAzm(entry);
        sessionCardio.push(entry);
        renderCardioList();
        renderFitbitList();
      };
      row.appendChild(btn);
    }
    list.appendChild(row);
  });
}

// ── FITBIT HISTORY SYNC ──────────────────────────────────
// Pulls every Fitbit exercise session on the account. Re-runnable: sessions
// already imported are skipped. Cardio becomes cardio-only entries; lifting
// becomes a "Weightlifting (Fitbit)" entry, or attaches its Fitbit stats (AZM,
// heart rate) to a workout you already logged that day.

// A Fitbit walk/hike only counts as a workout if it's long and hard enough
const WALK_MIN_MINUTES = 45;
const WALK_MIN_AZM     = 15;
const walkCounts = (minutes, azm) => minutes >= WALK_MIN_MINUTES && (azm || 0) >= WALK_MIN_AZM;

// Unmapped Fitbit types that still count as cardio (imported as "Other").
// Everything else (walks, hikes, chores…) is skipped to keep history clean.
const FITBIT_OTHER_CARDIO = new Set(['HIIT', 'CARDIO_WORKOUT', 'AEROBIC_WORKOUT', 'INTERVAL_WORKOUT',
  'BOOTCAMP', 'KICKBOXING', 'BOXING', 'CROSS_TRAINING', 'TABATA_WORKOUT', 'STEP_TRAINING',
  'CARDIO_SCULPT', 'ZUMBA', 'DANCING', 'WATER_AEROBICS']);

const fitbitMeta = s => ({ id: s.id, type: s.exerciseType, name: s.name, isLift: s.isLift,
  minutes: s.minutes, azm: s.azm, avgHr: s.avgHr, calories: s.calories });

// Every exercise session Fitbit has, newest first, 25 per request
async function fetchFitbitAll(token, onPage) {
  const all = [];
  let pageToken = '';
  for (let page = 0; page < 400; page++) { // safety cap: 10,000 sessions
    const url = `${FITBIT.api}/exercise/dataPoints?pageSize=25` +
                (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (resp.status === 401) {
      fitbitToken = null;
      try { sessionStorage.removeItem('fitbitToken'); } catch {}
      throw new Error('Google sign-in expired. Tap Sync again to sign back in.');
    }
    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.json()).error?.message || ''; } catch {}
      throw new Error(`Fitbit request failed (${resp.status}). ${detail}`);
    }
    const data = await resp.json();
    all.push(...(data.dataPoints || []).filter(dp => dp.exercise));
    onPage(all.length);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return all;
}

function syncFitbitHistory() {
  const status = document.getElementById('fitbit-sync-status');
  const btn = document.getElementById('fitbit-sync-btn');
  status.classList.remove('fitbit-error');
  status.textContent = 'Signing in…';
  btn.disabled = true;

  getFitbitToken() // called straight from the tap so the sign-in popup isn't blocked
    .then(token => {
      status.textContent = 'Downloading Fitbit workouts…';
      return fetchFitbitAll(token,
        n => { status.textContent = `Downloading Fitbit workouts… ${n} found`; });
    })
    .then(importFitbitSessions)
    .then(summary => {
      status.textContent = summary;
      renderHome();
      renderHistory();
      refreshProgress();
    })
    .catch(err => {
      status.classList.add('fitbit-error');
      status.textContent = err.message;
    })
    .finally(() => { btn.disabled = false; });
}

async function importFitbitSessions(dataPoints) {
  const workouts = await dbGetAll('workouts');
  const known = new Set();
  workouts.forEach(w => {
    if (w.fitbit?.id) known.add(w.fitbit.id);
    (w.cardio || []).forEach(c => c.fitbitId && known.add(c.fitbitId));
  });

  const n = { cardio: 0, cardioMatched: 0, lifts: 0, liftsMatched: 0, already: 0 };
  const skipped = {};
  const sameDay = (w, dateStr) => localDateStr(new Date(w.date)) === dateStr;

  for (const dp of dataPoints) {
    const s = fitbitSessionInfo(dp);
    if (known.has(s.id)) { n.already++; continue; }
    const dateStr = localDateStr(new Date(s.startTime));

    if (s.isLift) {
      // Attach to a lifting workout you logged that day, if one has no Fitbit stats yet
      const logged = workouts.find(w => hasLifting(w) && !w.fitbit && sameDay(w, dateStr));
      if (logged) {
        logged.fitbit = fitbitMeta(s);
        await dbPut('workouts', logged);
        n.liftsMatched++;
      } else {
        const w = { dayId: null, date: s.startTime, sets: {}, cardio: [], notes: '', fitbit: fitbitMeta(s) };
        w.id = await dbPut('workouts', w);
        workouts.push(w);
        n.lifts++;
      }
    } else if (s.cardioType === 'Walk/Hike' && !walkCounts(s.minutes, s.azm)) {
      // Only walks/hikes of 45+ min with 15+ Active Zone Minutes count as workouts
      skipped[`${s.name} (short/easy)`] = (skipped[`${s.name} (short/easy)`] || 0) + 1;
      continue;
    } else if (FITBIT_CARDIO_MAP[s.exerciseType] || FITBIT_OTHER_CARDIO.has(s.exerciseType)) {
      const entry = { type: s.cardioType, minutes: s.minutes, fitbitId: s.id,
                      azm: s.azm, avgHr: s.avgHr, calories: s.calories };
      capCardioToAzm(entry);
      // A cardio entry you typed in by hand that day with the same type is the same session
      const logged = workouts.find(w => sameDay(w, dateStr) &&
        (w.cardio || []).some(c => !c.fitbitId && c.type === s.cardioType));
      if (logged) {
        const c = logged.cardio.find(c => !c.fitbitId && c.type === s.cardioType);
        Object.assign(c, { fitbitId: s.id, azm: s.azm, avgHr: s.avgHr, calories: s.calories });
        capCardioToAzm(c);
        await dbPut('workouts', logged);
        n.cardioMatched++;
      } else {
        const w = { dayId: null, date: s.startTime, sets: {}, cardio: [entry], notes: '' };
        w.id = await dbPut('workouts', w);
        workouts.push(w);
        n.cardio++;
      }
    } else {
      skipped[s.name] = (skipped[s.name] || 0) + 1;
      continue;
    }
    known.add(s.id);
  }

  const parts = [];
  parts.push(`Imported ${n.cardio} cardio and ${n.lifts} lifting session${n.lifts === 1 ? '' : 's'}.`);
  if (n.cardioMatched || n.liftsMatched) {
    parts.push(`Added Fitbit stats to ${n.cardioMatched + n.liftsMatched} entr${n.cardioMatched + n.liftsMatched === 1 ? 'y' : 'ies'} you'd already logged.`);
  }
  if (n.already) parts.push(`${n.already} already imported.`);
  const skippedList = Object.entries(skipped).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`);
  if (skippedList.length) parts.push(`Skipped (not lifting/cardio): ${skippedList.join(', ')}.`);
  if (n.lifts) parts.push('Lifting sessions can be assigned to a day from the History tab (optional).');
  return parts.join(' ');
}

// ── SAVE WORKOUT ─────────────────────────────────────────
async function saveWorkout() {
  // Include cardio that was entered but not yet added with "Add Cardio"
  const pendingType = document.getElementById('cardio-type').value;
  const pendingMin  = parseInt(document.getElementById('cardio-minutes').value);
  if (pendingType && pendingMin > 0) {
    sessionCardio.push({ type: pendingType, minutes: pendingMin });
    document.getElementById('cardio-minutes').value = '';
    renderCardioList();
  }

  const hasSets = Object.values(sessionSets).some(s =>
    s.some(r => r.reps || r.weight)
  );
  if (!hasSets && !sessionCardio.length) {
    if (editingWorkout && confirm('Everything was removed. Delete this logged workout?')) {
      await dbDelete('workouts', editingWorkout.id);
      showToast('Workout deleted', 'success');
      await renderHome();
      setLogDate(localDateStr());
      return;
    }
    showToast('Nothing to save', 'error');
    return;
  }

  // Keep only sets that were actually filled in; drop exercises left blank
  const sets = {};
  Object.entries(sessionSets).forEach(([exId, rows]) => {
    const filled = rows.filter(r => r.reps || r.weight).map(r => ({ ...r }));
    if (filled.length) sets[exId] = filled;
  });

  // Today keeps the actual time; a backlogged day is stored at local noon
  // so it stays on that calendar date regardless of time zone
  const isToday = logDate === localDateStr();
  let date = isToday ? new Date() : parseLocalDate(logDate);
  if (!isToday) date.setHours(12, 0, 0, 0);
  if (editingWorkout) date = new Date(editingWorkout.date); // keep original timestamp

  const workout = {
    ...(editingWorkout ? { id: editingWorkout.id } : {}),
    ...(editingWorkout?.fitbit ? { fitbit: editingWorkout.fitbit } : {}),
    dayId:  activeDay,
    date:   date.toISOString(),
    sets,
    cardio: [...sessionCardio],
    notes:  document.getElementById('workout-notes').value.trim()
  };

  await dbPut('workouts', workout);
  showToast(editingWorkout ? 'Workout updated!' : isToday ? 'Workout saved!'
    : `Saved for ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, 'success');
  await renderHome();
  setLogDate(localDateStr()); // back to today so the next log isn't misdated
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
      <button class="history-delete" title="Delete workout" aria-label="Delete workout">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 19a2 2 0 002 2h8a2 2 0 002-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      </button>
      <div class="history-date">${new Date(w.date).toLocaleDateString('en-US',
        { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}</div>
      <div class="history-title">${workoutTitle(w)}</div>
      <div class="history-meta">
        ${[exNames.length ? `${exNames.length} exercise${exNames.length === 1 ? '' : 's'}` : '',
           cardioMin ? `${cardioMin} min cardio` : '',
           w.notes ? `"${w.notes}"` : ''].filter(Boolean).join(' · ')}
      </div>
      ${w.fitbit ? `<div class="history-fitbit">⌚ ${[w.fitbit.name, `${w.fitbit.minutes} min`,
          w.fitbit.azm ? `${w.fitbit.azm} AZM` : '', w.fitbit.avgHr ? `${w.fitbit.avgHr} bpm avg` : '',
          w.fitbit.calories ? `${w.fitbit.calories} cal` : ''].filter(Boolean).join(' · ')}</div>` : ''}
      <ul class="history-exercises">
        ${exNames.map(n => `<li>${n}</li>`).join('')}
        ${(w.cardio || []).map(c => `<li>${c.type} — ${c.minutes} min${c.azm ? ` · ${c.azm} AZM` : ''}${c.fitbitMinutes ? ` (${c.fitbitMinutes} min total)` : ''}${c.fitbitId ? ' ⌚' : ''}</li>`).join('')}
      </ul>
      ${w.fitbit?.isLift && !hasLifting(w) ? `
        <select class="input-field history-assign">
          <option value="">${w.dayId ? 'Change day…' : 'Assign to a training day…'}</option>
          ${exercises.days.map(d => `<option value="${d.id}">D${d.id}: ${d.label}</option>`).join('')}
        </select>` : ''}
    `;
    const assign = el.querySelector('.history-assign');
    if (assign) assign.onchange = async () => {
      if (!assign.value) return;
      w.dayId = Number(assign.value);
      await dbPut('workouts', w);
      showToast('Assigned to ' + workoutTitle(w), 'success');
      renderHistory();
      renderHome();
    };
    el.querySelector('.history-delete').onclick = async () => {
      const when = new Date(w.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const what = workoutTitle(w);
      if (!confirm(`Delete the ${what} workout from ${when}? This can't be undone.`)) return;
      await dbDelete('workouts', w.id);
      showToast('Workout deleted', 'success');
      await renderHistory();
      await renderHome();
      if (editingWorkout?.id === w.id) initSessionForDay(activeDay); // Log page was showing it
    };
    list.appendChild(el);
  });
}

// ── PROGRESS ─────────────────────────────────────────────
async function renderProgress() {
  const workouts = await dbGetAll('workouts');
  earliestWorkout = workouts.length
    ? new Date(Math.min(...workouts.map(w => new Date(w.date).getTime())))
    : null;

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

  updateProgressLabels();
  renderWorkoutsChart(workouts);
  renderCardioChart(workouts);
  renderAzmChart(workouts);
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

function chartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false, // height comes from the .chart-box container
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#888', font: { size: 11 } }, grid: { color: '#2e2e2e' } },
      y: { ticks: { color: '#888', font: { size: 11 } }, grid: { color: '#2e2e2e' }, beginAtZero: true }
    }
  };
}

// Categorical colors (fixed order, validated for colorblind separation on the dark surface).
// Color follows the entity: Day N and each cardio type always get the same color.
const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'];
const OTHER_COLOR   = '#6b6b68';
const CHART_SURFACE = '#1a1a1a';

// Time range toggle. Short ranges use weekly bars; longer ranges switch to
// monthly bars so a year stays readable on a phone (13 bars instead of 52).
const RANGES = {
  '1m': { months: 1,  unit: 'week'  },
  '3m': { months: 3,  unit: 'week'  },
  '6m': { months: 6,  unit: 'month' },
  '1y': { months: 12, unit: 'month' },
  'all': { months: null, unit: 'month' } // back to the first logged or imported workout
};
let progressRange = '1m';
let earliestWorkout = null; // set by renderProgress, used for the All range
const rangeUnit = () => RANGES[progressRange].unit;

function rangeStart() {
  if (!RANGES[progressRange].months) {
    const first = earliestWorkout || new Date();
    return new Date(first.getFullYear(), first.getMonth(), 1);
  }
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setMonth(d.getMonth() - RANGES[progressRange].months);
  return d;
}

const pad2 = n => String(n).padStart(2, '0');
const monthKey = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;

// Every period (week or month) in the selected range, oldest first,
// including empty ones so gaps are visible
function periodBuckets() {
  const start = rangeStart(), keys = [];
  if (rangeUnit() === 'week') {
    const thisWeek = getWeekStart(new Date());
    for (let d = getWeekStart(start); d <= thisWeek; d.setDate(d.getDate() + 7)) keys.push(localDateStr(d));
  } else {
    const end = new Date();
    for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d <= end; d.setMonth(d.getMonth() + 1)) {
      keys.push(monthKey(d));
    }
  }
  return keys;
}

const periodKey = w => rangeUnit() === 'week'
  ? localDateStr(getWeekStart(new Date(w.date)))
  : monthKey(new Date(w.date));

function periodLabel(key) {
  if (rangeUnit() === 'week') {
    return parseLocalDate(key).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  const [y, m] = key.split('-').map(Number);
  const label = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' });
  return y === new Date().getFullYear() ? label : `${label} '${String(y).slice(2)}`;
}

const inRange = w => new Date(w.date) >= (rangeUnit() === 'week' ? getWeekStart(rangeStart()) : rangeStart());

function setupRangeToggle() {
  document.querySelectorAll('#range-toggle button').forEach(btn => {
    btn.onclick = () => {
      progressRange = btn.dataset.range;
      document.querySelectorAll('#range-toggle button').forEach(b =>
        b.classList.toggle('active', b === btn));
      refreshProgress();
    };
  });
}

function updateProgressLabels() {
  const per = rangeUnit() === 'week' ? 'WEEK' : 'MONTH';
  document.getElementById('label-workouts').textContent = `WORKOUT DAYS PER ${per}`;
  document.getElementById('label-cardio').textContent   = `CARDIO MINUTES PER ${per}`;
  document.getElementById('label-azm').textContent      = `ACTIVE ZONE MINUTES PER ${per}`;
}

function stackedBarOptions(yTitle, unit) {
  const base = chartDefaults();
  return {
    ...base,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        display: true,
        position: 'bottom',
        labels: { color: '#bbb', boxWidth: 10, boxHeight: 10, font: { size: 11 } }
      },
      tooltip: {
        filter: item => item.raw > 0,
        callbacks: {
          title: items => (rangeUnit() === 'week' ? 'Week of ' : '') + items[0].label,
          label: item => ` ${item.dataset.label}: ${item.raw}${unit}`,
          footer: items => 'Total: ' + items.reduce((s, i) => s + i.raw, 0) + unit
        }
      }
    },
    scales: {
      x: { ...base.scales.x, stacked: true, grid: { display: false } },
      y: {
        ...base.scales.y, stacked: true,
        ticks: { ...base.scales.y.ticks, precision: 0 },
        title: { display: true, text: yTitle, color: '#888', font: { size: 11 } }
      }
    }
  };
}

function stackedDataset(label, data, color) {
  return {
    label, data,
    backgroundColor: color,
    borderColor: CHART_SURFACE,  // thin gap between stacked segments
    borderWidth: { top: 2 },
    borderSkipped: 'start',
    borderRadius: 4              // Chart.js rounds only the top of each stack
  };
}

function drawChart(key, canvasId, labels, datasets, options) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  if (progressCharts[key]) progressCharts[key].destroy();
  progressCharts[key] = new Chart(ctx, { type: 'bar', data: { labels, datasets }, options });
}

// A day counts as a workout day if it has 30+ cardio load (Active Zone Minutes
// from Fitbit, across cardio and lifting), or more than 30 min of weightlifting.
// Cardio typed in without Fitbit data counts its minutes as load; lifting logged
// with sets but no Fitbit duration counts as a full session.
const WORKOUT_DAY_MIN_LOAD = 30;
const WORKOUT_DAY_MIN_LIFT = 30;

function dayLoad(dayWorkouts) {
  return dayWorkouts.reduce((sum, w) =>
    sum + (w.fitbit?.azm || 0) +
    (w.cardio || []).reduce((s, c) => s + (c.azm ?? (c.fitbitId ? 0 : Number(c.minutes) || 0)), 0), 0);
}

function isWorkoutDay(dayWorkouts) {
  const liftedEnough = dayWorkouts.some(w =>
    (w.fitbit?.isLift && w.fitbit.minutes > WORKOUT_DAY_MIN_LIFT) ||
    (hasLifting(w) && !w.fitbit?.minutes));
  return liftedEnough || dayLoad(dayWorkouts) >= WORKOUT_DAY_MIN_LOAD;
}

// Group workouts by local calendar date
function groupByDate(workouts) {
  const byDate = {};
  workouts.forEach(w => (byDate[localDateStr(new Date(w.date))] ??= []).push(w));
  return byDate;
}

// Workout DAYS per period: each qualifying calendar day counts once, so lifting
// followed by cardio is one day, not two. A day is labelled by what it included,
// in priority order: training day D1-D4 > Weightlifting (lifting not assigned to
// a day) > Other (cardio only).
function dayCategory(dayWorkouts) {
  if (!isWorkoutDay(dayWorkouts)) return null;
  const assigned = dayWorkouts.find(w => isLiftWorkout(w) && w.dayId);
  if (assigned) return 'D' + assigned.dayId;
  if (dayWorkouts.some(isLiftWorkout)) return 'lift';
  if (dayWorkouts.some(w => (w.cardio || []).length)) return 'other';
  return null;
}

function renderWorkoutsChart(workouts) {
  const periods = periodBuckets();
  const byDate = groupByDate(workouts);

  const counts = {}; // category -> per-period day counts
  Object.values(byDate).forEach(dayWs => {
    const cat = dayCategory(dayWs);
    const i = periods.indexOf(periodKey(dayWs[0]));
    if (!cat || i < 0) return;
    (counts[cat] ??= periods.map(() => 0))[i]++;
  });
  const zeros = periods.map(() => 0);

  const datasets = exercises.days.map((day, i) => stackedDataset(`D${day.id}: ${day.label}`,
    counts['D' + day.id] || zeros, SERIES_COLORS[i] || OTHER_COLOR));
  if (counts.lift)  datasets.push(stackedDataset('Weightlifting', counts.lift, SERIES_COLORS[4]));
  if (counts.other) datasets.push(stackedDataset('Other', counts.other, OTHER_COLOR));

  const options = stackedBarOptions('Workout days', '');
  options.plugins.tooltip.callbacks.footer = items =>
    'Total: ' + items.reduce((s, i) => s + i.raw, 0) + ' days';
  if (rangeUnit() === 'week') options.scales.y.suggestedMax = 5; // weekly goal ceiling
  drawChart('workouts', 'chart-workouts', periods.map(periodLabel), datasets, options);
}

// Cardio types past the 8th color fold into "Other" rather than reusing a color
function cardioGroup(type) {
  const idx = exercises.cardioTypes.indexOf(type);
  return idx >= 0 && idx < SERIES_COLORS.length && type !== 'Other' ? type : 'Other';
}

// Cardio minutes, stacked by type. Weekly view draws each cardio entry as its
// own segment so 10+10+40 min reads differently from 20+20+20; monthly view
// sums per type (dozens of slivers per bar would be unreadable).
function renderCardioChart(workouts) {
  const periods = periodBuckets();
  const perEntry = rangeUnit() === 'week';

  // Monthly view: types under 10% of the range's cardio minutes fold into Other
  // so the legend only lists the ones that matter
  const minor = new Set();
  if (!perEntry) {
    const totals = {};
    let all = 0;
    workouts.forEach(w => {
      if (!periods.includes(periodKey(w))) return;
      (w.cardio || []).forEach(c => {
        const m = Number(c.minutes) || 0;
        totals[cardioGroup(c.type)] = (totals[cardioGroup(c.type)] || 0) + m;
        all += m;
      });
    });
    const ALWAYS_SHOWN = new Set(['Lawn Mowing']);
    Object.entries(totals).forEach(([g, m]) => {
      if (all && m / all < 0.10 && !ALWAYS_SHOWN.has(g)) minor.add(g);
    });
  }
  const groupFor = type => { const g = cardioGroup(type); return minor.has(g) ? 'Other' : g; };

  const entries = {}; // group -> { period -> [minutes, ...] } in logged order
  [...workouts].sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(w =>
    (w.cardio || []).forEach(c => {
      const g = groupFor(c.type), p = periodKey(w);
      entries[g] ??= {};
      (entries[g][p] ??= []).push(Number(c.minutes) || 0);
    }));

  const groups = [...exercises.cardioTypes.map(cardioGroup), 'Other']
    .filter((g, i, arr) => arr.indexOf(g) === i && entries[g] && periods.some(p => entries[g][p]))
    .sort((a, b) => (a === 'Other') - (b === 'Other'));

  const datasets = [];
  groups.forEach(g => {
    const color = g === 'Other' ? OTHER_COLOR : SERIES_COLORS[exercises.cardioTypes.indexOf(g)];
    if (!perEntry) {
      const ds = stackedDataset(g, periods.map(p => (entries[g][p] || []).reduce((a, b) => a + b, 0)), color);
      ds.firstOfType = true;
      datasets.push(ds);
      return;
    }
    const slots = Math.max(...periods.map(p => entries[g][p]?.length || 0), 1);
    for (let k = 0; k < slots; k++) {
      const ds = stackedDataset(g, periods.map(p => entries[g][p]?.[k] || 0), color);
      ds.firstOfType = k === 0;
      datasets.push(ds);
    }
  });

  const options = stackedBarOptions('Minutes', ' min');
  options.plugins.legend.labels.filter = item => datasets[item.datasetIndex].firstOfType;
  options.plugins.legend.onClick = () => {}; // types span several datasets; keep legend static
  drawChart('cardio', 'chart-cardio', periods.map(periodLabel), datasets, options);
}

// Active Zone Minutes from Fitbit, split into cardio vs lifting sessions
function renderAzmChart(workouts) {
  const periods = periodBuckets();
  const cardio = periods.map(() => 0), lifting = periods.map(() => 0);
  let any = false;
  workouts.forEach(w => {
    const i = periods.indexOf(periodKey(w));
    if (i < 0) return;
    (w.cardio || []).forEach(c => { if (c.azm) { cardio[i] += c.azm; any = true; } });
    if (w.fitbit?.isLift && w.fitbit.azm) { lifting[i] += w.fitbit.azm; any = true; }
  });

  document.getElementById('azm-empty').classList.toggle('hidden', any);
  const datasets = [
    stackedDataset('Cardio', cardio, SERIES_COLORS[0]),
    stackedDataset('Lifting', lifting, SERIES_COLORS[1])
  ];
  drawChart('azm', 'chart-azm', periods.map(periodLabel), datasets, stackedBarOptions('AZM', ' AZM'));
}

function renderWeightChart(workouts, exId) {
  if (!exId) return;
  const points = workouts
    .filter(w => w.sets?.[exId]?.length && inRange(w))
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
  document.getElementById('fitbit-sync-btn').onclick = syncFitbitHistory;
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
    body += `${workoutTitle(w)}\n\n`;

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
  week.filter(hasLifting).forEach(w => {
    const day = exercises.days.find(d => d.id === w.dayId);
    body += `${workoutTitle(w)}\n`;
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
