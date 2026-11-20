// A tiny event bus on the game state. Systems that must not depend on each other
// (the shift report, careers, objectives) listen here instead of being imported
// by the code that produces the event. A leaf module: it imports nothing.

export function on(state, name, fn) {
  state.hooks = state.hooks ?? {};
  (state.hooks[name] = state.hooks[name] ?? []).push(fn);
}

export function emit(state, name, data) {
  const list = state.hooks?.[name];
  if (!list) return;
  for (const fn of list) fn(state, data);
}
