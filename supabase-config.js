// Holds the connection to Supabase, configured by the user at runtime (no
// secrets are hard-coded into the app — the anon key is public-safe by
// design, but still lives per-device in localStorage, not in this file).
const RoomConfig = (() => {
  const KEY = 'cycle_room_config';

  function get() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || null;
    } catch (e) {
      return null;
    }
  }
  function save(cfg) {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  }
  function clear() {
    localStorage.removeItem(KEY);
  }
  return { get, save, clear };
})();

let supabaseClient = null;

function initSupabase() {
  const cfg = RoomConfig.get();
  if (!cfg || !cfg.url || !cfg.anonKey) return null;
  if (!window.supabase) return null; // CDN script not loaded (offline)
  supabaseClient = window.supabase.createClient(cfg.url, cfg.anonKey);
  return supabaseClient;
}
