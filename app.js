const ENTRIES_KEY = 'cycle_entries';
const MOODS_KEY = 'cycle_moods';

// Seed data — only used the very first time the app runs on a device, and
// only in local-only mode (never pushed to a shared room automatically).
const SEED_ENTRIES = [
  { start: '2026-01-14', end: '2026-01-18' },
  { start: '2026-02-20', end: '2026-02-25' },
  { start: '2026-04-19', end: '2026-04-24' },
  { start: '2026-06-03', end: null },
  { start: '2026-07-30', end: '2026-08-04' },
  { start: '2026-09-07', end: null }
];

let entries = [];
let moods = []; // [{date, mood, user?}]
let roomConfig = null;
let realtimeChannel = null;

function todayISO() { return new Date().toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000); }
function fmtDate(iso) { return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function fmtDateShort(iso) { return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function average(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const avg = average(arr);
  return Math.sqrt(average(arr.map(x => (x - avg) ** 2)));
}

// ---------- Local cache (used as offline fallback + local-only mode) ----------
function loadLocalEntries() {
  try {
    entries = JSON.parse(localStorage.getItem(ENTRIES_KEY));
    if (!Array.isArray(entries)) throw new Error('bad data');
  } catch (e) {
    entries = isConnected() ? [] : SEED_ENTRIES.slice();
  }
  entries.sort((a, b) => new Date(a.start) - new Date(b.start));
}
function saveLocalEntries() {
  localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
  syncPredictionToDB();
}
function loadLocalMoods() {
  try {
    moods = JSON.parse(localStorage.getItem(MOODS_KEY));
    if (!Array.isArray(moods)) throw new Error('bad data');
  } catch (e) {
    moods = [];
  }
}
function saveLocalMoods() { localStorage.setItem(MOODS_KEY, JSON.stringify(moods)); }

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

// ---------- Rendering ----------
function render() {
  renderStats();
  renderPredictions();
  renderSuggestions();
  renderHistory();
  renderMood();
}

function renderStats() {
  const { avgCycle, avgPeriod, sd } = getPredictionInfo();
  document.getElementById('stats').innerHTML = `
    <div class="stat"><div class="num">${entries.length ? Math.round(avgCycle) : '–'}</div><div class="label">Avg cycle length (days)</div></div>
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
  const rows = [];
  const base = new Date(lastStart + 'T00:00:00');
  for (let i = 1; i <= 3; i++) {
    const predicted = new Date(base);
    predicted.setDate(predicted.getDate() + Math.round(avgCycle * i));
    const early = new Date(predicted); early.setDate(early.getDate() - Math.round(sd || 3));
    const late = new Date(predicted); late.setDate(late.getDate() + Math.round(sd || 3));
    rows.push(`
      <div class="predict-row">
        <div>
          <div class="predict-date">${predicted.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</div>
          <div class="predict-tag">${i === 1 ? 'Next period' : `Cycle +${i}`}</div>
        </div>
        <div class="predict-range">${early.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${late.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
      </div>`);
  }
  predEl.innerHTML = rows.join('');
  const cycleLengths = computeCycleLengths();
  const variability = sd > 10 ? 'highly irregular' : sd > 5 ? 'somewhat irregular' : 'fairly regular';
  noteEl.textContent = `Based on ${cycleLengths.length} cycle(s) logged, your cycle has been ${variability} (varying roughly ±${Math.round(sd)} days). Predictions are estimates, not guarantees.`;
}

function currentCyclePhase() {
  if (!entries.length) return null;
  const { avgCycle, avgPeriod, lastStart } = getPredictionInfo();
  const dayInCycle = (daysBetween(lastStart, todayISO()) % Math.round(avgCycle) + Math.round(avgCycle)) % Math.round(avgCycle) + 1;
  const ovulationDay = Math.max(1, Math.round(avgCycle) - 14);
  if (dayInCycle <= avgPeriod) return 'menstrual';
  if (dayInCycle < ovulationDay - 1) return 'follicular';
  if (dayInCycle <= ovulationDay + 1) return 'ovulation';
  return 'luteal';
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

  const recentMoods = moods.slice(-3);
  if (recentMoods.length >= 2) {
    const avgMood = average(recentMoods.map(m => m.mood));
    if (avgMood <= 2) {
      tips.push({ tag: 'Check in', text: "You've logged a few lower moods recently — it might help to lighten your schedule, get extra rest, or talk to someone you trust." });
    }
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
  const sorted = entries.slice().sort((a, b) => new Date(b.start) - new Date(a.start));
  el.innerHTML = sorted.map(e => {
    const len = e.end ? `${daysBetween(e.start, e.end) + 1} days` : 'ongoing / not recorded';
    const dateStr = e.end
      ? `${fmtDateShort(e.start)} – ${fmtDateShort(e.end)}, ${new Date(e.start).getFullYear()}`
      : `${fmtDate(e.start)} –`;
    return `<div class="entry" data-start="${e.start}">
      <div class="dates">${dateStr}<div class="len">${len}</div></div>
      <button data-delete="${e.start}" data-id="${e.id || ''}">✕</button>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteEntry(btn.getAttribute('data-delete'), btn.getAttribute('data-id')));
  });
}

function renderMood() {
  const today = todayISO();
  const todays = moods.find(m => m.date === today && (!m.user || m.user === roomConfig?.userLabel));
  document.querySelectorAll('#moodRow .mood-btn').forEach(btn => {
    btn.classList.toggle('selected', todays && String(todays.mood) === btn.getAttribute('data-mood'));
  });
  document.getElementById('moodToday').textContent = todays ? "Today's mood logged — tap another to change it." : 'Tap one to log today.';

  const recent = moods.slice().sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 7);
  const emojiFor = { 1: '😣', 2: '😔', 3: '😐', 4: '🙂', 5: '😄' };
  document.getElementById('moodHistory').innerHTML = recent.map(m =>
    `<div class="mood-chip">${emojiFor[m.mood]} ${fmtDateShort(m.date)}${m.user ? ' · ' + m.user : ''}</div>`
  ).join('');
}

async function renderMessages() {
  const feedEl = document.getElementById('messageFeed');
  if (!isConnected() || !roomConfig) { feedEl.innerHTML = ''; return; }
  const msgs = await fetchMessagesRemote(roomConfig.roomCode);
  if (!msgs) return;
  const emojiFor = { 1: '😣', 2: '😔', 3: '😐', 4: '🙂', 5: '😄' };
  if (!msgs.length) { feedEl.innerHTML = '<div class="empty">No messages yet.</div>'; return; }
  feedEl.innerHTML = msgs.map(m => `
    <div class="message">
      <div class="who"><span>${m.user_label}${m.mood ? ' ' + emojiFor[m.mood] : ''}</span><span class="when">${new Date(m.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div>
      <div class="body">${escapeHtml(m.body)}</div>
    </div>`).join('');
}
function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ---------- Actions ----------
async function deleteEntry(start, id) {
  entries = entries.filter(e => e.start !== start);
  saveLocalEntries();
  if (isConnected() && id) await deleteEntryRemote(id);
  render();
}

async function logMood(moodVal) {
  const today = todayISO();
  const existing = moods.find(m => m.date === today && (!m.user || m.user === roomConfig?.userLabel));
  if (existing) existing.mood = moodVal;
  else moods.push({ date: today, mood: moodVal, user: roomConfig?.userLabel });
  saveLocalMoods();
  if (isConnected()) await upsertMoodRemote(roomConfig.roomCode, roomConfig.userLabel, today, moodVal);
  renderMood();
  renderSuggestions();
}

document.getElementById('addBtn').addEventListener('click', async () => {
  const start = document.getElementById('startInput').value;
  const end = document.getElementById('endInput').value;
  if (!start) { alert('Please enter a start date.'); return; }
  let newId = null;
  if (isConnected()) {
    await addEntryRemote(roomConfig.roomCode, roomConfig.userLabel, start, end);
    await refreshFromRemote(['period_entries']);
  } else {
    entries.push({ start, end: end || null });
    entries.sort((a, b) => new Date(a.start) - new Date(b.start));
    saveLocalEntries();
  }
  document.getElementById('startInput').value = '';
  document.getElementById('endInput').value = '';
  render();
});

document.querySelectorAll('#moodRow .mood-btn').forEach(btn => {
  btn.addEventListener('click', () => logMood(Number(btn.getAttribute('data-mood'))));
});

let selectedShareMood = null;
document.querySelectorAll('#shareMoodRow .mood-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    selectedShareMood = Number(btn.getAttribute('data-share-mood'));
    document.querySelectorAll('#shareMoodRow .mood-btn').forEach(b => b.classList.toggle('selected', b === btn));
  });
});
document.getElementById('sendShareBtn').addEventListener('click', async () => {
  if (!isConnected()) { alert('Connect to a shared account first (see the Shared Account card above).'); return; }
  const text = document.getElementById('shareText').value.trim();
  if (!text && !selectedShareMood) { alert('Pick a mood or write a note first.'); return; }
  await sendMessageRemote(roomConfig.roomCode, roomConfig.userLabel, text || '(no note)', selectedShareMood);
  document.getElementById('shareText').value = '';
  selectedShareMood = null;
  document.querySelectorAll('#shareMoodRow .mood-btn').forEach(b => b.classList.remove('selected'));
  renderMessages();
});

// ---------- Shared account setup ----------
function populateSetupForm() {
  if (!roomConfig) return;
  document.getElementById('supaUrl').value = roomConfig.url || '';
  document.getElementById('supaKey').value = roomConfig.anonKey || '';
  document.getElementById('roomCode').value = roomConfig.roomCode || '';
  document.getElementById('userLabel').value = roomConfig.userLabel || '';
}

async function connect() {
  const url = document.getElementById('supaUrl').value.trim();
  const anonKey = document.getElementById('supaKey').value.trim();
  const roomCodeVal = document.getElementById('roomCode').value.trim();
  const userLabel = document.getElementById('userLabel').value.trim();
  const statusEl = document.getElementById('connectStatus');

  if (!url || !anonKey || !roomCodeVal || !userLabel) {
    statusEl.textContent = 'Fill in all four fields to connect.';
    return;
  }
  roomConfig = { url, anonKey, roomCode: roomCodeVal, userLabel };
  RoomConfig.save(roomConfig);
  initSupabase();

  const remoteEntries = await fetchEntriesRemote(roomCodeVal);
  if (remoteEntries === null) {
    statusEl.textContent = 'Could not connect — check your URL/key and that you ran the schema.sql setup.';
    return;
  }
  statusEl.textContent = `Connected as ${userLabel} in room "${roomCodeVal}".`;
  document.getElementById('modeSub').textContent = `Shared with your partner · room "${roomCodeVal}"`;
  document.getElementById('shareCard').style.display = 'block';
  await refreshFromRemote(['period_entries', 'moods']);
  render();
  renderMessages();
  subscribeToRoom();
  await trySubscribePush();
}
document.getElementById('connectBtn').addEventListener('click', connect);

async function refreshFromRemote(tables) {
  if (!isConnected() || !roomConfig) return;
  if (tables.includes('period_entries')) {
    const remote = await fetchEntriesRemote(roomConfig.roomCode);
    if (remote) { entries = remote; saveLocalEntries(); }
  }
  if (tables.includes('moods')) {
    const remote = await fetchMoodsRemote(roomConfig.roomCode);
    if (remote) { moods = remote; saveLocalMoods(); }
  }
}

function subscribeToRoom() {
  if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
  realtimeChannel = subscribeRealtime(roomConfig.roomCode, async (table, payload) => {
    if (table === 'period_entries') { await refreshFromRemote(['period_entries']); render(); }
    if (table === 'moods') { await refreshFromRemote(['moods']); render(); }
    if (table === 'messages') {
      renderMessages();
      if (payload && payload.new && payload.new.user_label !== roomConfig.userLabel) {
        notifyIncomingMessage(payload.new);
      }
    }
  });
}

function notifyIncomingMessage(msg) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const emojiFor = { 1: '😣', 2: '😔', 3: '😐', 4: '🙂', 5: '😄' };
  new Notification(`${msg.user_label} shared how they're feeling`, {
    body: `${msg.mood ? emojiFor[msg.mood] + ' ' : ''}${msg.body}`,
    icon: 'icons/icon.svg'
  });
}

// ---------- Notifications ----------
async function syncPredictionToDB() {
  if (!window.indexedDB) return;
  const info = getPredictionInfo();
  try { await CycleDB.set('prediction', info); } catch (e) { /* ignore */ }
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
    statusEl.textContent = isConnected()
      ? 'Reminders are on, including a notification when your partner shares how they feel (while this app is installed and opened regularly).'
      : 'Reminders are on. You\u2019ll get a notification before your predicted period and a daily nudge to log your mood.';
    btn.textContent = 'Reminders enabled';
    btn.disabled = true;
  } else if (Notification.permission === 'denied') {
    statusEl.textContent = 'Notifications were blocked. Enable them for this app in your phone/browser settings to turn reminders back on.';
    btn.disabled = true;
  } else {
    statusEl.textContent = 'Turn on reminders for upcoming periods, daily mood check-ins, and messages from your partner.';
    btn.disabled = false;
  }
}

async function enableNotifications() {
  if (!('Notification' in window)) return;
  const perm = await Notification.requestPermission();
  updateNotifyUI();
  if (perm === 'granted') {
    await syncPredictionToDB();
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      if ('periodicSync' in reg) {
        try { await reg.periodicSync.register('cycle-check', { minInterval: 20 * 60 * 60 * 1000 }); } catch (e) { /* not supported */ }
      }
    }
    checkAndNotifyNow();
    await trySubscribePush();
  }
}
document.getElementById('notifyBtn').addEventListener('click', enableNotifications);

function checkAndNotifyNow() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const { avgCycle, lastStart } = getPredictionInfo();
  if (lastStart) {
    const nextDate = new Date(lastStart + 'T00:00:00');
    nextDate.setDate(nextDate.getDate() + Math.round(avgCycle));
    const daysUntil = daysBetween(todayISO(), nextDate.toISOString().slice(0, 10));
    if (daysUntil >= 0 && daysUntil <= 2) {
      new Notification('Period expected soon', {
        body: `Predicted around ${nextDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.`,
        icon: 'icons/icon.svg'
      });
    }
  }
  const today = todayISO();
  if (!moods.find(m => m.date === today)) {
    new Notification('How are you feeling today?', { body: 'Tap to log today\u2019s mood.', icon: 'icons/icon.svg' });
  }
}

// Web Push subscription for true cross-device notifications (works even
// when the app isn't open) — only activates if VAPID_PUBLIC_KEY below is
// filled in and the notify edge function is deployed. See README.
const VAPID_PUBLIC_KEY = ''; // paste your generated VAPID public key here

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function trySubscribePush() {
  if (!VAPID_PUBLIC_KEY || !isConnected() || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }
    await savePushSubscriptionRemote(roomConfig.roomCode, roomConfig.userLabel, sub.toJSON());
  } catch (e) { console.error('Push subscribe failed', e); }
}

// ---------- Init ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js').catch(() => {});
}

roomConfig = RoomConfig.get();
if (roomConfig) {
  populateSetupForm();
  initSupabase();
}
loadLocalEntries();
loadLocalMoods();
render();
updateNotifyUI();
syncPredictionToDB();

if (roomConfig && isConnected()) {
  document.getElementById('modeSub').textContent = `Shared with your partner · room "${roomConfig.roomCode}"`;
  document.getElementById('shareCard').style.display = 'block';
  refreshFromRemote(['period_entries', 'moods']).then(() => { render(); });
  renderMessages();
  subscribeToRoom();
  trySubscribePush();
}
