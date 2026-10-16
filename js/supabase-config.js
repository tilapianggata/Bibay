// Cloud connection is built in, so nobody has to paste anything.
// The publishable/anon key is meant to be public. If saving ever fails with an
// auth error, replace SUPABASE_KEY with the "anon" key (eyJ...) from
// Supabase > Settings > API Keys > "Legacy anon, service_role API keys".
const SUPABASE_URL = 'https://gdvjzadblobfahuutene.supabase.co';
const SUPABASE_KEY = 'sb_publishable_amdDyt-pFarbN8XGcfmCZw_aqgCOlrT';
const ROOM_CODE = 'room-207cb5baef7ee624b47dc76e';   // identifies her data in the shared tables
const USER_LABEL = 'me';

let supabaseClient = null;

function initSupabase() {
  if (!window.supabase) return null; // CDN script not loaded (offline)
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  return supabaseClient;
}
