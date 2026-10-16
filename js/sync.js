// Talks to Supabase. Every function returns null/false on failure (and sets
// lastSyncError) so the app keeps working offline.
let lastSyncError = '';

function isConnected() { return !!supabaseClient; }
function fail(error) {
  console.error(error);
  lastSyncError = (error && error.message) ? error.message : String(error);
  return null;
}

async function fetchEntriesRemote() {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient
    .from('period_entries').select('*').eq('room_code', ROOM_CODE)
    .order('start_date', { ascending: true });
  if (error) return fail(error);
  return data.map(d => ({ start: d.start_date, end: d.end_date, id: d.id }));
}

async function addEntryRemote(start, end) {
  if (!supabaseClient) return false;
  const { error } = await supabaseClient.from('period_entries')
    .insert({ room_code: ROOM_CODE, user_label: USER_LABEL, start_date: start, end_date: end || null });
  if (error) { fail(error); return false; }
  return true;
}

async function deleteEntryRemote(id) {
  if (!supabaseClient) return false;
  const { error } = await supabaseClient.from('period_entries').delete().eq('id', id);
  if (error) { fail(error); return false; }
  return true;
}

async function fetchMoodsRemote() {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient
    .from('moods').select('*').eq('room_code', ROOM_CODE)
    .order('mood_date', { ascending: true });
  if (error) return fail(error);
  return data.map(d => ({ date: d.mood_date, mood: d.mood }));
}

async function upsertMoodRemote(date, mood) {
  if (!supabaseClient) return false;
  const { error } = await supabaseClient.from('moods').upsert(
    { room_code: ROOM_CODE, user_label: USER_LABEL, mood_date: date, mood },
    { onConflict: 'room_code,user_label,mood_date' }
  );
  if (error) { fail(error); return false; }
  return true;
}
