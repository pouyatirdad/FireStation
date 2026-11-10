import { CONFIG } from '../core/config.js';

// One dispatch log for the whole shift. The HUD reads it; nothing else writes
// to it directly.
export function addEvent(state, text, tone = 'info') {
  const event = {
    id: ++state.eventSeq,
    t: state.time,
    text,
    tone,
  };
  state.events.unshift(event);
  if (state.events.length > CONFIG.logLimit) state.events.length = CONFIG.logLimit;
  state.lastEvent = event;
  return event;
}
