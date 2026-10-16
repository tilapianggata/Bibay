const ENTRIES_KEY = 'cycle_entries';
const MOODS_KEY = 'cycle_moods';

let entries = []; // [{start, end, id?, pending?}]
let moods = [];   // [{date, mood, pending?}]
let calView = (() => { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() }; })();

// ---------- Date helpers (all local time; toISOString() shifts the day in UTC+ zones) ----------
function pad(n) { return String(n).padStart(2, '0'); }
function toISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseISO(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(iso, n) { const d = parseISO(iso); d.setDate(d.getDate() + n); return toISO(d); }
function todayISO() { return toISO(new Date()); }
function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }
function fmtDate(iso) { return parseISO(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function fmtDateShort(iso) { return parseISO(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function average(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const avg = average(arr);
  return Math.sqrt(average(arr.map(x => (x - avg) ** 2)));
}

// ---------- Local cache (offline fallback) ----------
function loadLocalEntries() {
  try {
    entries = JSON.parse(localStorage.getItem(ENTRIES_KEY));
    if (!Array.isArray(entries)) throw new Error('bad data');
  } catch (e) { entries = []; }
  entries.sort((a, b) => a.start.localeCompare(b.start));
}
function saveLocalEntries() {
  localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
  syncPredictionToDB();
}
function loadLocalMoods() {
  try {
    moods = JSON.parse(localStorage.getItem(MOODS_KEY));
    if (!Array.isArray(moods)) throw new Error('bad data');
  } catch (e) { moods = []; }
}
function saveLocalMoods() { localStorage.setItem(MOODS_KEY, JSON.stringify(moods)); }

// ---------- Cloud sync ----------
function setStatus(msg, ok) {
  const el = document.getElementById('syncStatus');
  el.textContent = msg;
  el.className = 'sync-status' + (ok === true ? ' ok' : ok === false ? ' bad' : '');
}
function syncFailed() {
  const why = !isConnected() ? 'No connection.' : (lastSyncError ? lastSyncError.slice(0, 80) : '');
  setStatus(`Not saved to the cloud yet (kept on this phone). ${why}`, false);
}

let syncing = false;
async function syncNow() {
  if (syncing) return;
  if (!isConnected()) initSupabase();
  if (!isConnected()) { syncFailed(); return; }
  syncing = true;
  setStatus('Syncing…');
  try {
    let remoteEntries = await fetchEntriesRemote();
    let remoteMoods = await fetchMoodsRemote();
    if (remoteEntries === null || remoteMoods === null) { syncFailed(); return; }

    // Push anything saved offline (or everything, if the cloud is still empty).
    const known = new Set(remoteEntries.map(e => e.start));
    const pushEntries = entries.filter(e => (e.pending || remoteEntries.length === 0) && !known.has(e.start));
    for (const e of pushEntries) {
      if (!(await addEntryRemote(e.start, e.end))) { syncFailed(); return; }
    }
    const pushMoods = moods.filter(m => m.pending || remoteMoods.length === 0);
    for (const m of pushMoods) {
      if (!(await upsertMoodRemote(m.date, m.mood))) { syncFailed(); return; }
    }

    if (pushEntries.length) remoteEntries = await fetchEntriesRemote();
    if (pushMoods.length) remoteMoods = await fetchMoodsRemote();
    if (remoteEntries === null || remoteMoods === null) { syncFailed(); return; }

    entries = remoteEntries; saveLocalEntries();
    moods = remoteMoods; saveLocalMoods();
    render();
    setStatus('Saved to the cloud ✓', true);
  } finally {
    syncing = false;
  }
}

// ---------- Core calculations ----------
function computeCycleLengths() {
  const lens = [];
  for (let i = 1; i < entries.length; i++) lens.push(daysBetween(entries[i - 1].start, entries[i].start));
  return lens;
}
function computePeriodLengths() {
  return entries.filter(e => e.end).map(e => daysBetween(e.start, e.end) + 1);
}
function getPredictionInfo() {
  const cycleLengths = computeCycleLengths();
  const avgCycle = average(cycleLengths) || 28;
  const sd = stdDev(cycleLengths);
  const lastStart = entries.length ? entries[entries.length - 1].start : null;
  return { avgCycle, sd, lastStart, avgPeriod: average(computePeriodLengths()) || 5 };
}

// Maps every date in the logged/predicted range to a calendar type:
// period | predicted | follicular | fertile | luteal
function buildDayMap() {
  const map = {};
  if (!entries.length) return map;
  const { avgCycle, avgPeriod } = getPredictionInfo();
  const L = Math.max(Math.round(avgCycle), 20);
  const P = Math.max(Math.round(avgPeriod), 1);

  const cycles = entries.map(e => ({ start: e.start, end: e.end, predicted: false }));
  if (entries.length >= 2) {
    const last = entries[entries.length - 1].start;
    for (let i = 1; i <= 3; i++) cycles.push({ start: addDays(last, L * i), end: null, predicted: true });
  }
  cycles.forEach((c, i) => {
    const next = i + 1 < cycles.length ? cycles[i + 1].start : addDays(c.start, L);
    const len = Math.max(daysBetween(c.start, next), 1);
    const ovulation = len - 14;
    const periodEnd = c.end || addDays(c.start, P - 1);
    for (let n = 0; n < len; n++) {
      const iso = addDays(c.start, n);
      const day = n + 1;
      let type;
      if (iso <= periodEnd) type = c.predicted ? 'predicted' : 'period';
      else if (day < ovulation - 4) type = 'follicular';
      else if (day <= ovulation + 1) type = 'fertile';
      else type = 'luteal';
      map[iso] = type;
    }
  });
  return map;
}

// ---------- Rendering ----------
function render() {
  renderCalendar();
  renderStats();
  renderPredictions();
  renderSuggestions();
  renderHistory();
  renderMood();
}

const DROP_SVG = '<svg viewBox="0 0 40 48" aria-hidden="true"><path d="M20 3C20 3 6 19 6 31a14 14 0 0 0 28 0C34 19 20 3 20 3Z"/></svg>';
const TYPE_LABEL = {
  period: 'period', predicted: 'expected period', follicular: 'follicular phase',
  fertile: 'fertile window', luteal: 'luteal phase'
};

function renderCalendar() {
  const { y, m } = calView;
  const map = buildDayMap();
  const first = new Date(y, m, 1);
  const lead = (first.getDay() + 6) % 7; // week starts Monday
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const today = todayISO();

  document.getElementById('calTitle').textContent =
    first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  let html = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => `<div class="cal-dow">${d}</div>`).join('');
  html += '<div></div>'.repeat(lead);
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${y}-${pad(m + 1)}-${pad(d)}`;
    const type = map[iso] || '';
    const drop = (type === 'period' || type === 'predicted') ? DROP_SVG : '';
    const label = `${fmtDate(iso)}${type ? ', ' + TYPE_LABEL[type] : ''}`;
    html += `<button class="cal-day ${type}${iso === today ? ' today' : ''}" data-date="${iso}" aria-label="${label}">${drop}<span class="num">${d}</span></button>`;
  }
  document.getElementById('calGrid').innerHTML = html;
}

document.getElementById('calPrev').addEventListener('click', () => shiftMonth(-1));
document.getElementById('calNext').addEventListener('click', () => shiftMonth(1));
function shiftMonth(delta) {
  const d = new Date(calView.y, calView.m + delta, 1);
  calView = { y: d.getFullYear(), m: d.getMonth() };
  renderCalendar();
}
document.getElementById('calGrid').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.cal-day');
  if (!btn) return;
  const input = document.getElementById('startInput');
  input.value = btn.getAttribute('data-date');
  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

function renderStats() {
  const { avgCycle, avgPeriod, sd } = getPredictionInfo();
  document.getElementById('stats').innerHTML = `
    <div class="stat"><div class="num">${entries.length > 1 ? Math.round(avgCycle) : '–'}</div><div class="label">Avg cycle length (days)</div></div>
    <div class="stat"><div class="num">${entries.some(e => e.end) ? Math.round(avgPeriod) : '–'}</div><div class="label">Avg period length (days)</div></div>
    <div class="stat"><div class="num">${entries.length}</div><div class="label">Periods logged</div></div>
    <div class="stat"><div class="num">${sd ? '±' + Math.round(sd) : '–'}</div><div class="label">Cycle variability</div></div>
  `;
}

function renderPredictions() {
  const predEl = document.getElementById('predictions');
  const noteEl = document.getElementById('predictionNote');
  if (entries.length < 2) {
    predEl.innerHTML = '<div class="empty">Log at least 2 periods to get predictions.</div>';
    noteEl.textContent = '';
    return;
  }
  const { avgCycle, sd, lastStart } = getPredictionInfo();
  const spread = Math.round(sd || 3);
  const rows = [];
  for (let i = 1; i <= 3; i++) {
    const predicted = addDays(lastStart, Math.round(avgCycle * i));
    rows.push(`
      <div class="predict-row">
        <div>
          <div class="predict-date">${parseISO(predicted).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</div>
          <div class="predict-tag">${i === 1 ? 'Next period' : `Cycle +${i}`}</div>
        </div>
        <div class="predict-range">${fmtDateShort(addDays(predicted, -spread))} – ${fmtDateShort(addDays(predicted, spread))}</div>
      </div>`);
  }
  predEl.innerHTML = rows.join('');
  const n = computeCycleLengths().length;
  const variability = sd > 10 ? 'highly irregular' : sd > 5 ? 'somewhat irregular' : 'fairly regular';
  noteEl.textContent = `Based on ${n} cycle(s) logged, your cycle has been ${variability} (varying roughly ±${Math.round(sd)} days). Predictions are estimates, not guarantees.`;
}

function currentCyclePhase() {
  const type = buildDayMap()[todayISO()];
  return { period: 'menstrual', predicted: 'menstrual', follicular: 'follicular', fertile: 'ovulation', luteal: 'luteal' }[type] || null;
}

const PHASE_TIPS = {
  menstrual: [
    { tag: 'Rest', text: 'Energy tends to be lowest now — gentle movement like walking or stretching is usually kinder than intense training.' },
    { tag: 'Nutrition', text: 'Iron-rich foods (leafy greens, beans, lean meat) can help offset blood loss.' },
    { tag: 'Comfort', text: 'A heating pad or warm bath can ease cramping for many people.' }
  ],
  follicular: [
    { tag: 'Energy', text: 'Energy and mood often start climbing — a good window for starting new projects or harder workouts.' },
    { tag: 'Planning', text: 'This phase is often a good stretch for tackling focus-heavy tasks.' }
  ],
  ovulation: [
    { tag: 'Peak energy', text: 'This is typically the highest-energy window in the cycle — good for strength training or big social plans.' },
    { tag: 'Hydration', text: 'Keep water intake up, especially with more intense activity.' }
  ],
  luteal: [
    { tag: 'Mood', text: 'PMS-type symptoms (irritability, cravings, fatigue) are common in this phase for many people.' },
    { tag: 'Nutrition', text: 'Magnesium-rich foods (nuts, dark chocolate, leafy greens) and cutting back on caffeine/sugar may ease symptoms for some.' },
    { tag: 'Self-care', text: 'Extra sleep and lower-key plans can help if you tend to feel drained before your period.' }
  ]
};

function renderSuggestions() {
  const el = document.getElementById('suggestions');
  const phase = currentCyclePhase();
  let tips = [];
  if (phase) tips = tips.concat(PHASE_TIPS[phase]);

  const recentMoods = moods.slice().sort((a, b) => a.date.localeCompare(b.date)).slice(-3);
  if (recentMoods.length >= 2 && average(recentMoods.map(m => m.mood)) <= 2) {
    tips.push({ tag: 'Check in', text: "You've logged a few lower moods recently — it might help to lighten your schedule, get extra rest, or talk to someone you trust." });
  }
  if (!tips.length) {
    el.innerHTML = '<div class="empty">Log a period and a mood or two to get personalized suggestions.</div>';
    return;
  }
  el.innerHTML = tips.map(t => `<div class="suggestion"><div class="tag">${t.tag}</div>${t.text}</div>`).join('')
    + '<div class="note">General wellness info, not medical advice — check with a doctor for anything persistent or concerning.</div>';
}

function renderHistory() {
  const el = document.getElementById('history');
  document.getElementById('countBadge').textContent = entries.length;
  if (!entries.length) { el.innerHTML = '<div class="empty">No periods logged yet.</div>'; return; }
  const sorted = entries.slice().sort((a, b) => b.start.localeCompare(a.start));
  el.innerHTML = sorted.map(e => {
    const len = e.end ? `${daysBetween(e.start, e.end) + 1} days` : 'ongoing / not recorded';
    const dateStr = e.end
      ? `${fmtDateShort(e.start)} – ${fmtDateShort(e.end)}, ${parseISO(e.start).getFullYear()}`
      : `${fmtDate(e.start)} –`;
    return `<div class="entry">
      <div class="dates">${dateStr}<div class="len">${len}${e.pending ? ' · waiting to sync' : ''}</div></div>
      <button data-delete="${e.start}" data-id="${e.id || ''}" aria-label="Delete entry">✕</button>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteEntry(btn.getAttribute('data-delete'), btn.getAttribute('data-id')));
  });
}

function renderMood() {
  const today = todayISO();
  const todays = moods.find(m => m.date === today);
  document.querySelectorAll('#moodRow .mood-btn').forEach(btn => {
    btn.classList.toggle('selected', !!todays && String(todays.mood) === btn.getAttribute('data-mood'));
  });
  document.getElementById('moodToday').textContent = todays ? "Today's mood logged — tap another to change it." : 'Tap one to log today.';

  const emojiFor = { 1: '😣', 2: '😔', 3: '😐', 4: '🙂', 5: '😄' };
  const recent = moods.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7);
  document.getElementById('moodHistory').innerHTML = recent.map(m =>
    `<div class="mood-chip">${emojiFor[m.mood]} ${fmtDateShort(m.date)}</div>`
  ).join('');
}

// ---------- Actions ----------
async function deleteEntry(start, id) {
  if (!confirm('Delete this entry?')) return;
  if (id) {
    if (!isConnected() || !(await deleteEntryRemote(id))) {
      alert('Could not delete — check your internet connection and try again.');
      return;
    }
  }
  entries = entries.filter(e => e.start !== start);
  saveLocalEntries();
  render();
}

async function logMood(moodVal) {
  const today = todayISO();
  let m = moods.find(x => x.date === today);
  if (m) { m.mood = moodVal; m.pending = true; }
  else { m = { date: today, mood: moodVal, pending: true }; moods.push(m); }
  saveLocalMoods();
  renderMood();
  renderSuggestions();
  if (isConnected() && await upsertMoodRemote(today, moodVal)) {
    m.pending = false;
    saveLocalMoods();
    setStatus('Saved to the cloud ✓', true);
  } else {
    syncFailed();
  }
}

document.getElementById('addBtn').addEventListener('click', async () => {
  const start = document.getElementById('startInput').value;
  const end = document.getElementById('endInput').value;
  if (!start) { alert('Please enter a start date.'); return; }
  if (end && end < start) { alert('The end date is before the start date.'); return; }
  if (entries.some(e => e.start === start)) { alert('You already logged a period starting that day.'); return; }

  const entry = { start, end: end || null, pending: true };
  entries.push(entry);
  entries.sort((a, b) => a.start.localeCompare(b.start));
  saveLocalEntries();
  document.getElementById('startInput').value = '';
  document.getElementById('endInput').value = '';
  render();

  if (isConnected() && await addEntryRemote(start, end)) {
    entry.pending = false;
    syncNow(); // re-pulls so the entry gets its cloud id
  } else {
    syncFailed();
  }
});

document.querySelectorAll('#moodRow .mood-btn').forEach(btn => {
  btn.addEventListener('click', () => logMood(Number(btn.getAttribute('data-mood'))));
});

// ---------- Notifications ----------
// Android (and the installed app) only allows notifications through the service
// worker, so `new Notification(...)` is avoided.
async function showNote(title, body) {
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, { body, icon: 'icons/icon.svg' });
  } catch (e) { console.error('Notification failed', e); }
}

async function syncPredictionToDB() {
  if (!window.indexedDB) return;
  try { await CycleDB.set('prediction', getPredictionInfo()); } catch (e) { /* ignore */ }
}

function updateNotifyUI() {
  const statusEl = document.getElementById('notifyStatus');
  const btn = document.getElementById('notifyBtn');
  if (!('Notification' in window)) {
    statusEl.textContent = 'Notifications are not supported in this browser.';
    btn.disabled = true;
    return;
  }
  if (Notification.permission === 'granted') {
    statusEl.textContent = 'Reminders are on. You’ll get a heads-up before your predicted period and a nudge to log your mood.';
    btn.textContent = 'Reminders enabled';
    btn.disabled = true;
  } else if (Notification.permission === 'denied') {
    statusEl.textContent = 'Notifications were blocked. Enable them for this app in your phone settings to turn reminders back on.';
    btn.disabled = true;
  } else {
    statusEl.textContent = 'Turn on reminders for upcoming periods and daily mood check-ins.';
    btn.disabled = false;
  }
}

async function enableNotifications() {
  if (!('Notification' in window)) return;
  const perm = await Notification.requestPermission();
  updateNotifyUI();
  if (perm !== 'granted') return;
  await syncPredictionToDB();
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.ready;
    if ('periodicSync' in reg) {
      try { await reg.periodicSync.register('cycle-check', { minInterval: 20 * 60 * 60 * 1000 }); } catch (e) { /* not supported */ }
    }
  }
  checkAndNotifyNow();
}
document.getElementById('notifyBtn').addEventListener('click', enableNotifications);

function checkAndNotifyNow() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const { avgCycle, lastStart } = getPredictionInfo();
  if (lastStart) {
    const next = addDays(lastStart, Math.round(avgCycle));
    const daysUntil = daysBetween(todayISO(), next);
    if (daysUntil >= 0 && daysUntil <= 2) {
      showNote('Period expected soon', `Predicted around ${fmtDateShort(next)}.`);
    }
  }
  if (!moods.find(m => m.date === todayISO())) {
    showNote('How are you feeling today?', 'Tap to log today’s mood.');
  }
}

// ---------- Init ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js').catch(() => {});
}
initSupabase();
loadLocalEntries();
loadLocalMoods();
render();
updateNotifyUI();
syncPredictionToDB();
syncNow();
window.addEventListener('online', syncNow);
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
