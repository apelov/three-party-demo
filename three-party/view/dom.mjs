// Elements and words for the page.
//
// Every text the page shows comes from one of three places: a line of the copy
// deck (copy.json), a string of the label map (labels.json), or a value the
// run API returned. The element that holds a text names that place in its
// data-src attribute, so a check can walk the document and compare each text
// with its source:
//
//   copy:<key>                      a copy line with no placeholder
//   copy:<key>;<name>=<source>;...  a copy line, each {name} filled from a source
//   copy:<key>;when=<source>        a copy word chosen by a run value
//   labels:<path>                   a string of the label map
//   run:<path>                      a value of the run state
//   run:<document>#<path>           a value of another document of the run:
//                                   files/<relative path>, offline-check, post
//   run:...|<shaping>               the value shown in a shaped form (below)
//   run:<time path>|sinceStart      a time of the run, shown as the seconds
//                                   from the run's startedAt to it
//   run:<step path>|span            a step, shown as the seconds from its
//                                   startedAt to its endedAt
//
// A source inside a fill may also be clock:<path> (time left until a run
// time, on the browser clock), clock:<path>|since (whole seconds since a run
// time, on the browser clock), const:<name> (a constant of this view) or
// view:<name> (a number the page counted on itself: rows, the rows the trace
// shows now; replay, the step a replay stands at; step, the step selected;
// act and acts, where the walkthrough stands in its menu and how many items
// the menu has; position, an item's own place in the menu).
// Nothing here invents a word: a line whose fill has no value is not built.

export function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'src') node.dataset.src = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'data') Object.assign(node.dataset, value);
      // Styles go through the object model: the page's policy refuses a style attribute.
      else if (key === 'style') Object.assign(node.style, value);
      else if (key === 'on') for (const [name, fn] of Object.entries(value)) node.addEventListener(name, fn);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  return add(node, ...kids);
}

// Read a path such as steps[3].detail.calls[1].args.payeeAccount.
export function at(root, path) {
  if (path === '' || path === undefined) return root;
  let cur = root;
  for (const part of String(path).match(/[^.[\]]+/g) ?? []) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

const has = (value) => value !== null && value !== undefined && value !== '';

// The shaped forms a run value may be shown in. Each is a pure function of
// the value, so a check can redo it.
export const SHAPES = Object.freeze({
  hex16: (v) => String(v).slice(0, 16),
  afterLastSpace: (v) => String(v).slice(String(v).lastIndexOf(' ') + 1),
  commit8: (v) => (/[0-9a-f]{40}/.exec(String(v)) ?? [''])[0].slice(0, 8),
  time: (v) => String(v).replace(/T/, ' '),
  clock: (v) => String(v).slice(11),
  ordinal: (v) => String(Number(v) + 1),
  key: (v) => String(v),
  json: (v) => JSON.stringify(v, null, 2),
  count: (v) => String(Array.isArray(v) ? v.length : 0),
});

export function shaped(value, shape) {
  return shape ? SHAPES[shape](value) : String(value);
}

// Sources, written the one way the page and its checks read them.
export const from = Object.freeze({
  run: (path, shape) => `run:${path}${shape ? `|${shape}` : ''}`,
  doc: (name, path = '', shape) => `run:${name}#${path}${shape ? `|${shape}` : ''}`,
  file: (rel, path = '', shape) => `run:files/${rel}#${path}${shape ? `|${shape}` : ''}`,
  labels: (path) => `labels:${path}`,
  copy: (key) => `copy:${key}`,
  clock: (path, shape) => `clock:${path}${shape ? `|${shape}` : ''}`,
  constant: (name) => `const:${name}`,
  view: (name) => `view:${name}`,
});

// The seconds between two RFC 3339 times of the run, as the page shows them:
// one decimal when either string carries a fraction of a second, whole
// seconds otherwise. Null when either is missing or is not a time.
export function secondsBetween(start, end) {
  const from0 = Date.parse(start);
  const to = Date.parse(end);
  if (!has(start) || !has(end) || Number.isNaN(from0) || Number.isNaN(to)) return null;
  const fine = /\.\d/.test(String(start)) || /\.\d/.test(String(end));
  const seconds = (to - from0) / 1000;
  return fine ? seconds.toFixed(1) : String(Math.round(seconds));
}

const FILL = /\{([A-Za-z0-9]+)\}/g;

// The words of the page, bound to the copy deck and the label map in use.
export function words(copy, labels) {
  // A copy line without placeholders: { text, src }, or null when the deck
  // has no such key.
  function word(key) {
    const text = copy[key];
    return has(text) ? { text, src: from.copy(key) } : null;
  }

  // A copy word chosen by a run value (a state word, a decision word).
  function chosen(key, source) {
    const w = word(key);
    return w ? { text: w.text, src: `${w.src};when=${source}` } : null;
  }

  // A copy line with its placeholders filled. fills maps a placeholder name
  // to [value, source]. Returns null when the key or any fill has no value.
  function line(key, fills = {}) {
    const text = copy[key];
    if (!has(text)) return null;
    const used = [];
    let missing = false;
    const filled = text.replace(FILL, (_, name) => {
      const pair = fills[name];
      if (!pair || !has(pair[0])) { missing = true; return ''; }
      used.push(`${name}=${pair[1]}`);
      return String(pair[0]);
    });
    if (missing) return null;
    return { text: filled, src: [from.copy(key), ...used].join(';') };
  }

  // The same line as nodes, with the fills named in mono set in the
  // monospace face. The caller gives the nodes one parent that carries src.
  function lineNodes(key, fills = {}, mono = []) {
    const whole = line(key, fills);
    if (!whole) return null;
    const nodes = [];
    let last = 0;
    const text = copy[key];
    for (const m of text.matchAll(FILL)) {
      if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
      const value = String(fills[m[1]][0]);
      nodes.push(mono.includes(m[1]) ? el('span', { class: 'mono', text: value }) : document.createTextNode(value));
      last = m.index + m[0].length;
    }
    if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
    return { nodes, src: whole.src, text: whole.text };
  }

  // The part of a copy line before its parenthesis, for a line whose
  // parenthesis names a value this run does not carry.
  function beforeParen(key) {
    const text = copy[key];
    if (!has(text)) return null;
    const cutAt = text.indexOf(' (');
    return { text: cutAt < 0 ? text : text.slice(0, cutAt), src: `${from.copy(key)}|beforeParen` };
  }

  // A string of the label map.
  function label(path) {
    const text = at(labels, path);
    return typeof text === 'string' && text !== '' ? { text, src: from.labels(path) } : null;
  }

  return { word, chosen, line, lineNodes, beforeParen, label };
}

// A value of the run, or null when the run does not carry it.
export function value(root, path, shape, source = from.run) {
  const raw = at(root, path);
  if (!has(raw)) return null;
  return { text: shaped(raw, shape), src: source(path, shape), raw };
}

// The name of a field of the run (the last part of its path), for a table
// that uses the run's own field names as its keys; null when the run does
// not carry the field.
export function fieldName(root, path, source = from.run) {
  if (!has(at(root, path))) return null;
  const parts = String(path).match(/[^.[\]]+/g) ?? [];
  return { text: parts[parts.length - 1], src: source(path, 'key') };
}

// An element holding one sourced text: put(tag, cls, { text, src }).
export function put(tag, cls, w, extra) {
  if (!w) return null;
  return el(tag, { class: cls, src: w.src, text: w.nodes ? null : w.text, ...extra }, w.nodes ?? null);
}

// A <time> element: the run's string in datetime, a plainer form as its text.
export function timeEl(cls, v, shape = 'time') {
  if (!v) return null;
  return el('time', { class: cls, datetime: v.raw, src: `${v.src.replace(/\|.*$/, '')}|${shape}`, text: shaped(v.raw, shape) });
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

// Append what there is: a piece that was not built (null) is left out.
export function add(node, ...kids) {
  for (const kid of kids.flat(3)) if (kid !== null && kid !== undefined && kid !== false) node.append(kid);
  return node;
}

// Step ids such as grant-again name their copy keys in camel case.
export function camel(id) {
  return String(id).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
