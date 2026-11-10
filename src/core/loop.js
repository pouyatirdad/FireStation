import { CONFIG } from './config.js';

// Fixed-timestep loop: the simulation always advances in 1/60 s steps, so a
// fire behaves the same at 1x and 4x and on a slow machine. Rendering happens
// once per animation frame, not once per step.
//
// The scheduler is injectable so the loop can be driven by hand in tests.
export function createLoop({
  state,
  update,
  render,
  schedule = (fn) => requestAnimationFrame(fn),
  cancel = (handle) => cancelAnimationFrame(handle),
}) {
  let accumulator = 0;
  let last = null;
  let handle = null;

  function frame(now) {
    handle = schedule(frame);

    // 0 is a legitimate timestamp, so the first frame is flagged with null.
    if (last === null) {
      last = now;
      render(0);
      return;
    }
    let delta = now - last;
    last = now;
    if (delta > CONFIG.maxFrameMs) delta = CONFIG.maxFrameMs;

    if (!state.running || state.paused || state.over) {
      accumulator = 0;
      render(delta / 1000);
      return;
    }

    accumulator += delta * state.speed;
    let steps = 0;
    while (accumulator >= CONFIG.tickMs && steps < CONFIG.maxCatchUpTicks) {
      accumulator -= CONFIG.tickMs;
      update(CONFIG.tickMs / 1000);
      steps++;
    }
    // If the machine fell far behind, drop the backlog rather than simulating
    // a minute of fire in one frame.
    if (accumulator > CONFIG.tickMs * CONFIG.maxCatchUpTicks) accumulator = 0;
    render(delta / 1000);
  }

  return {
    start() {
      if (handle == null) handle = schedule(frame);
    },
    stop() {
      if (handle != null) {
        cancel(handle);
        handle = null;
        last = null;
        accumulator = 0;
      }
    },
  };
}
