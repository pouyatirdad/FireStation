// Keyboard shortcuts for selecting a vehicle. Every vehicle gets one (digits
// first, then a few letters the game does not use) and the player can rebind it.
// The game's own keys are reserved so a unit can never steal "D" for dispatch.

// Keys that already do something (see the key handler in main.js).
export const RESERVED_KEYS = new Set([
  'd', 'a', 'e', 'r', 'h', 'g', 'p', 'k', 'c', 'u', 'f', 'x', 'v', 't', 'm', 'b',
]);

// What a unit may be bound to, in the order they are handed out.
export const UNIT_KEYS = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'q', 'w', 's', 'z', 'i', 'j', 'l', 'n', 'o', 'y',
];

export const isUnitKey = (key) => UNIT_KEYS.includes(key);

/** The engine bound to a key, if any. */
export function engineByKey(state, key) {
  return state.engines.find((e) => e.hotkey === key) ?? null;
}

/** The first key no vehicle has, or '' if every key is taken. */
export function freeHotkey(state, except = null) {
  const taken = new Set(state.engines.filter((e) => e !== except && e.hotkey).map((e) => e.hotkey));
  return UNIT_KEYS.find((k) => !taken.has(k)) ?? '';
}

/**
 * Bind a key to a vehicle. If another vehicle already has it, the two swap, so
 * nobody ends up without a shortcut. An empty key clears the binding.
 * Returns false when the key is not one a unit may use.
 */
export function bindHotkey(state, engine, key) {
  if (!engine) return false;
  if (!key) {
    engine.hotkey = '';
    return true;
  }
  if (!isUnitKey(key)) return false;
  const holder = engineByKey(state, key);
  if (holder && holder !== engine) holder.hotkey = engine.hotkey ?? '';
  engine.hotkey = key;
  return true;
}

/** Give every vehicle without a (valid, unique) key the first free one. */
export function ensureHotkeys(state) {
  const seen = new Set();
  for (const engine of state.engines) {
    if (engine.hotkey && isUnitKey(engine.hotkey) && !seen.has(engine.hotkey)) seen.add(engine.hotkey);
    else engine.hotkey = '';
  }
  for (const engine of state.engines) {
    if (engine.hotkey) continue;
    const key = UNIT_KEYS.find((k) => !seen.has(k)) ?? '';
    engine.hotkey = key;
    if (key) seen.add(key);
  }
}
