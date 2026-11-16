// The contract's label map, three-party/labels.json, as the tests read it,
// and the check of an answer to GET /api/labels: every member of the map
// with the value the file has, and beside them the screens' own words when
// the listener serves the screens, and nothing else.
//
// The expected values are read here from the two files themselves, apart
// from the code that builds the answer.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const THREE_PARTY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LABEL_MAP_FILE = path.join(THREE_PARTY, 'labels.json');
export const VIEW_LABELS_FILE = path.join(THREE_PARTY, 'view', 'labels.json');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export const labelMap = () => readJson(LABEL_MAP_FILE);
export const viewWords = () => readJson(VIEW_LABELS_FILE);

// The names of the words the screens add: on a part, on a scene.
const PART_WORDS = ['text', 'detail'];
const SCENE_WORDS = ['title', 'text', 'available'];

// answer: the parsed body of GET /api/labels. withWords: whether the listener
// serves the screens. Returns the number of values compared.
export function assertLabelMapAnswer(answer, { withWords }) {
  const map = labelMap();
  const words = viewWords();
  let compared = 0;
  assert.deepEqual(Object.keys(answer), Object.keys(map), 'the members of the map, in its order, and no other');
  for (const key of ['revision', 'parties', 'timestamp']) {
    assert.deepEqual(answer[key], map[key], key);
    compared += 1;
  }

  assert.deepEqual(Object.keys(answer.parts), Object.keys(map.parts));
  for (const [name, part] of Object.entries(map.parts)) {
    const got = answer.parts[name];
    for (const [member, value] of Object.entries(part)) {
      assert.deepEqual(got[member], value, `parts.${name}.${member} is the value of the map`);
      compared += 1;
    }
    const added = Object.keys(got).filter((member) => !Object.hasOwn(part, member));
    const expected = withWords ? PART_WORDS.filter((member) => Object.hasOwn(words.parts[name] ?? {}, member)) : [];
    assert.deepEqual(added, expected, `parts.${name}: the members beside those of the map`);
    for (const member of added) {
      assert.deepEqual(got[member], words.parts[name][member], `parts.${name}.${member} is the screens' word`);
      compared += 1;
    }
  }

  assert.equal(answer.scenes.length, map.scenes.length);
  map.scenes.forEach((scene, i) => {
    const got = answer.scenes[i];
    for (const [member, value] of Object.entries(scene)) {
      assert.deepEqual(got[member], value, `scenes[${i}].${member} is the value of the map`);
      compared += 1;
    }
    const added = Object.keys(got).filter((member) => !Object.hasOwn(scene, member));
    const sceneWords = words.scenes.find((s) => s.id === scene.id) ?? {};
    const expected = withWords ? SCENE_WORDS.filter((member) => Object.hasOwn(sceneWords, member)) : [];
    assert.deepEqual(added, expected, `scenes[${i}]: the members beside those of the map`);
    for (const member of added) {
      assert.deepEqual(got[member], sceneWords[member], `scenes[${i}].${member} is the screens' word`);
      compared += 1;
    }
  });
  return compared;
}

// Every string of the map a screen or a line of text mode can show for a
// part or a party: the part labels, the stand-in notes, the party roles, the
// note on raw identifiers and the two notes on the timestamp.
export function partAndPartyStrings(map = labelMap()) {
  const out = new Set();
  for (const part of Object.values(map.parts)) {
    out.add(part.label);
    if (part.standInNote) out.add(part.standInNote);
  }
  for (const value of Object.values(map.parties)) out.add(value);
  for (const value of Object.values(map.timestamp)) out.add(value);
  for (const scene of map.scenes) if (scene.standInNote) out.add(scene.standInNote);
  return [...out];
}
