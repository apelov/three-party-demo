// The constants of this view. They are structure, not words of the screen:
// the step order of the contract (section 4), used to lay out the flow before
// a run exists; the run kinds this build has no handler for; the command the
// text-mode line names; and the pace of the page's own polling.

export const STEP_ORDER = Object.freeze(['credential', 'grant', 'crossing', 'intent', 'pay', 'record']);
export const UNHANDLED_KINDS = Object.freeze(['received']);
export const OFFLINE_KIND = 'offline-check';
export const TEXT_MODE_COMMAND = 'node three-party/bin/start.mjs --text';
export const POLL_MS = 500;

// The window sizes the layout turns on. Story sizes need the room of 1440 by
// 860; the wide tier needs 1680 by 1000; under 1024 px the panes stack; from
// 1280 px the three panes stand at the widths the layout is measured at.
export const SIZES = Object.freeze({ stack: 1024, fullWidth: 1280, storyWidth: 1440, storyHeight: 860, wideWidth: 1680, wideHeight: 1000 });

const CONSTANTS = { stepOrder: STEP_ORDER, textModeCommand: TEXT_MODE_COMMAND };

// The value a const:<path> source names.
export function constantAt(path) {
  let cur = CONSTANTS;
  for (const part of String(path).match(/[^.[\]]+/g) ?? []) cur = cur?.[part];
  return cur;
}
