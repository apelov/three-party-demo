// The label map of the contract (CONTRACT.md section 1), three-party/labels.json:
// the one source of every part label, party role, stand-in note and scene
// button. This module reads it when it loads and holds no label of its own.
// The engine writes each step's part label and stand-in note from it, text
// mode prints them from the state the engine wrote, and the run API answers
// GET /api/labels with it.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LABEL_MAP_FILE = fileURLToPath(new URL('../../labels.json', import.meta.url));

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// One read: the bytes a listener sends are the bytes the engine's labels came from.
const BYTES = fs.readFileSync(LABEL_MAP_FILE);

export const LABEL_MAP = deepFreeze(JSON.parse(BYTES.toString('utf8')));

// The part ids of contract revision 1 stay as they are in state.json. The
// map's checkpoint part is `ours` there; every other part goes by its name in
// the map.
const STATE_PART_IDS = Object.freeze({ checkpoint: 'ours' });

// The part of the map whose steps list holds a step id: its name in the map,
// its id in state.json and the part itself.
export function partOfStep(stepId) {
  for (const [name, part] of Object.entries(LABEL_MAP.parts)) {
    if (part.steps.includes(stepId)) return { name, id: STATE_PART_IDS[name] ?? name, part };
  }
  throw new Error(`no part of the label map holds the step ${stepId}`);
}

// What a step of state.json carries from the map.
export function partFields(stepId) {
  const { id, part } = partOfStep(stepId);
  return { part: id, partLabel: part.label, standIn: part.standIn, standInNote: part.standInNote };
}

// The variants of the part that holds a step, by id (the crossing has a
// supplied one and a fallback), or null for a part with one form.
export function partVariants(stepId) {
  return partOfStep(stepId).part.variants ?? null;
}

// What a step of state.json carries from the variant of its part that runs.
export function variantFields(stepId, variant) {
  const v = partVariants(stepId)?.[variant];
  if (!v) throw new Error(`the part of the step ${stepId} has no variant ${variant}`);
  return { partLabel: v.label, standIn: v.standIn, standInNote: v.standInNote };
}

// The note a variant carries beside its stand-in note (the fallback of the
// crossing names where the AI2II capture comes from and how it is fetched),
// or null.
export function variantNote(stepId, variant) {
  if (!variant) return null;
  return partVariants(stepId)?.[variant]?.fetchNote ?? null;
}

// The note of the map for a record's timestamp entry: the stand-in note
// while the entry says stand-in, the note on the test authority otherwise.
export function timestampNote(entry) {
  return String(entry).startsWith('stand-in') ? LABEL_MAP.timestamp.standInNote : LABEL_MAP.timestamp.testAuthorityNote;
}

// The members the screens add to the answer of GET /api/labels. They are
// words of the screens, not labels: the line under a part, the line under a
// stand-in, the title and the line of a scene, and whether the build runs it.
export const PART_WORDS = Object.freeze(['text', 'detail']);
export const SCENE_WORDS = Object.freeze(['title', 'text', 'available']);

// The label map as a listener answers it. With no words it is the map as the
// file has it. With the screens' own file (three-party/view/labels.json,
// parsed), each part gains the screens' words for it and each scene the
// screens' words for the scene of the same id. A member of the map is never
// replaced: a word the screens' file gives under a name the map already has
// is left out.
export function labelMapWith(words = null) {
  const out = structuredClone(LABEL_MAP);
  if (!words || typeof words !== 'object') return out;
  const add = (target, source, names) => {
    if (!source || typeof source !== 'object') return;
    for (const name of names) {
      if (Object.hasOwn(source, name) && !Object.hasOwn(target, name)) target[name] = source[name];
    }
  };
  for (const [name, part] of Object.entries(out.parts)) add(part, words.parts?.[name], PART_WORDS);
  const scenes = Array.isArray(words.scenes) ? words.scenes : [];
  for (const scene of out.scenes) add(scene, scenes.find((s) => s && s.id === scene.id), SCENE_WORDS);
  return out;
}

// The same answer as the bytes a listener sends.
export function labelMapBytes(words = null) {
  if (!words) return Buffer.from(BYTES);
  return Buffer.from(`${JSON.stringify(labelMapWith(words), null, 2)}\n`, 'utf8');
}
