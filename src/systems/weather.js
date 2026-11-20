// Weather and light: a leaf module. Weather only changes two things the rest of
// the game already models — how fast vehicles can drive and how hard the wind
// blows — so it needs no system of its own. Scenarios and challenges set it;
// an ordinary shift has clear weather.

export const WEATHER = {
  clear: { label: 'Clear', roadFactor: 1, wind: 0 },
  rain: { label: 'Heavy rain', roadFactor: 0.88, wind: 0.1 },
  fog: { label: 'Dense fog', roadFactor: 0.8, wind: -0.1 },
  storm: { label: 'Storm', roadFactor: 0.75, wind: 0.35 },
  heat: { label: 'Heatwave', roadFactor: 1, wind: 0.05 },
};

/** 1 in full daylight, 0 in the dead of night. */
export function daylightLevel(clockMinutes) {
  const h = (((clockMinutes / 60) % 24) + 24) % 24;
  if (h >= 7 && h < 18) return 1;
  if (h >= 18 && h < 21) return 1 - (h - 18) / 3;
  if (h >= 21 || h < 5) return 0;
  return (h - 5) / 2;
}

export function setWeather(state, kind) {
  const w = WEATHER[kind] ?? WEATHER.clear;
  state.weather = { kind: WEATHER[kind] ? kind : 'clear', label: w.label, roadFactor: w.roadFactor };
  if (state.wind && w.wind) {
    state.wind.targetSpeed = Math.min(1, Math.max(0.05, state.wind.targetSpeed + w.wind));
    state.wind.speed = Math.min(1, Math.max(0.05, state.wind.speed + w.wind));
  }
  return state.weather;
}

export const roadFactor = (state) => state.weather?.roadFactor ?? 1;
