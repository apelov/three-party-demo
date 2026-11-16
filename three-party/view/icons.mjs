// The seven state icons. They are drawn once, as symbols of one hidden SVG
// sprite, and a row refers to its icon by name with <use>. A row therefore
// keeps the same <svg> element when its state changes, and the colour change
// passes through the row's transition. Every icon is aria-hidden: the state
// word beside it carries the meaning. The shapes differ (hollow circle, half
// circle, solid circle with a check, solid octagon with a bar, dashed circle,
// solid page with a folded corner, clock face), so the states read apart in
// grayscale. Strokes are 2 px on a 24 px box.

const SVG_NS = 'http://www.w3.org/2000/svg';

const ring = '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>';

// A solid shape with strokes cut out of it: the cut shows whatever lies
// behind the icon, so one drawing serves every tile colour.
function cut(id, solid, strokes) {
  return `<mask id="${id}-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect width="24" height="24" fill="#fff"/><g fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${strokes}</g></mask><g mask="url(#${id}-cut)">${solid}</g>`;
}

const SHAPES = Object.freeze({
  'circle-outline': () => ring,
  'circle-half': () => `${ring}<path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>`,
  'circle-check': (id) => cut(id, '<circle cx="12" cy="12" r="10" fill="currentColor"/>', '<path d="m7.4 12.5 3.1 3.1 6.1-6.6"/>'),
  'octagon-bar': (id) => cut(id, '<path d="M8.3 2h7.4L22 8.3v7.4L15.7 22H8.3L2 15.7V8.3z" fill="currentColor"/>', '<path d="M7.6 12h8.8"/>'),
  'circle-dashed': () => '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3.2 2.455"/>',
  'document-folded': (id) => cut(id, '<path d="M6.5 2h7.6L20 7.9V20a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="currentColor"/>', '<path d="M13.6 2.6v5.8h5.8"/><path d="M8.2 13.2h7.6M8.2 17h4.8"/>'),
  clock: () => `${ring}<path d="M12 7.2v5l3.2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
});

export const ICON_NAMES = Object.freeze(Object.keys(SHAPES));

const symbolId = (name) => `icon-${name}`;

// The markup of one symbol, for a check that the shapes differ.
export function shapeMarkup(name) {
  const draw = SHAPES[name];
  return draw ? draw(symbolId(name)) : null;
}

// Put the sprite in the document once.
export function installSprite(doc = document) {
  if (doc.getElementById('icon-sprite')) return;
  const holder = doc.createElement('div');
  holder.innerHTML = `<svg xmlns="${SVG_NS}" id="icon-sprite" class="sprite" width="0" height="0" aria-hidden="true" focusable="false">${ICON_NAMES.map((name) => `<symbol id="${symbolId(name)}" viewBox="0 0 24 24">${shapeMarkup(name)}</symbol>`).join('')}</svg>`;
  doc.body.append(holder.firstElementChild);
}

// A fresh icon element. An unknown name draws the hollow circle, so a state
// the map adds later still shows a shape.
export function iconEl(name, doc = document) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.append(doc.createElementNS(SVG_NS, 'use'));
  setIcon(svg, name);
  return svg;
}

// Change the shape an icon element shows; the element itself stays.
export function setIcon(svg, name) {
  const known = SHAPES[name] ? name : 'circle-outline';
  if (svg.dataset.icon === known) return;
  svg.dataset.icon = known;
  svg.firstElementChild.setAttribute('href', `#${symbolId(known)}`);
}
