// All functions here are no-ops (resolve to null/empty) if Supabase isn't
// configured yet, so the rest of the app can call them safely either way.

function isConnected() {
  return !!supabaseClient;
}

async function fetchEntriesRemote(roomCode) {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient
    .from('period_entries')
    .select('*')
    .eq('room_code', roomCode)
    .order('start_date', { ascending: true });
  if (error) { console.error(error); return null; }
  return data.map(d => ({ start: d.start_date, end: d.end_date, id: d.id }));
}

async function addEntryRemote(roomCode, userLabel, start, end) {
  if (!supabaseClient) return false;
  const { error } = await supabaseClient
    .from('period_entries')
    .insert({ room_code: roomCode, user_label: userLabel, start_date: start, end_date: end || null });
  if (error) console.error(error);
  return !error;
}

async function deleteEntryRemote(id) {
  if (!supabaseClient) return false;
  const { error } = await supabaseClient.from('period_entries').delete().eq('id', id);
  if (error) console.error(error);
  return !error;
}

async function fetchMoodsRemote(roomCode) {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient
    .from('moods')
    .select('*')
    .eq('room_code', roomCode)
    .order('mood_date', { ascending: true });
  if (error) { console.error(error); return null; }
  return data.map(d => ({ date: d.mood_date, mood: d.mood, user: d.user_label }));
}

async function upsertMoodRemote(roomCode, userLabel, date, mood) {
  if (!supabaseClient) return false;
  const { error } = await supabaseClient
    .from('moods')
    .upsert(
      { room_code: roomCode, user_label: userLabel, mood_date: date, mood },
      { onConflict: 'room_code,user_label,mood_date' }
    );
  if (error) console.error(error);
  return !error;
}

async function fetchMessagesRemote(roomCode, limit = 20) {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient
    .from('messages')
    .select('*')
    .eq('room_code', roomCode)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { console.error(error); return null; }
  return data;
}

async function sendMessageRemote(roomCode, userLabel, body, mood) {
  if (!supabaseClient) return false;
  const { error } = await supabaseClient
    .from('messages')
    .insert({ room_code: roomCode, user_label: userLabel, body, mood: mood || null });
  if (error) console.error(error);
  return !error;
}

async function savePushSubscriptionRemote(roomCode, userLabel, subscription) {
  if (!supabaseClient) return false;
  const { error } = await supabaseClient
    .from('push_subscriptions')
    .upsert(
      { room_code: roomCode, user_label: userLabel, subscription },
      { onConflict: 'room_code,user_label' }
    );
  if (error) console.error(error);
  return !error;
}

// Subscribes to live changes on the shared tables. `onChange` is called
// with the table name whenever a row is inserted/updated/deleted, so the
// caller can just re-fetch and re-render.
function subscribeRealtime(roomCode, onChange) {
  if (!supabaseClient) return null;
  const channel = supabaseClient
    .channel(`room-${roomCode}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'period_entries', filter: `room_code=eq.${roomCode}` },
      () => onChange('period_entries'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'moods', filter: `room_code=eq.${roomCode}` },
      () => onChange('moods'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `room_code=eq.${roomCode}` },
      (payload) => onChange('messages', payload))
    .subscribe();
  return channel;
}
