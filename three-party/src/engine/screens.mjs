// The screens: the files of three-party/view, served by the run API's own
// listener on 127.0.0.1, so the page and the API share one origin. The page
// loads its script, its stylesheet, its font, its copy deck and its label
// map from here and nothing from anywhere else, and the policy below says so
// to the browser.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VIEW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'view');
export const LABELS_FILE = 'labels.json';

// The same policy the view's development server sends (the integration tests
// compare the two).
export const SCREEN_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
});

// The view's own tools. The page does not load them, so they are not served.
const NOT_SERVED = Object.freeze(['dev-server.mjs', 'stills.mjs']);

// The file of the view a request path names, or null: the page itself for
// "/", else a path of plain names (no empty segment, no dot segment, no name
// that starts with a dot, no backslash), of a type the page loads, that is a
// regular file whose resolved path is still inside the view directory.
export function screenFile(viewDir, urlPath) {
  let relative;
  try {
    relative = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath).replace(/^\//, '');
  } catch {
    return null;
  }
  const segments = relative.split('/');
  if (segments.some((s) => s === '' || s.startsWith('.') || /[\\\0]/.test(s))) return null;
  const type = TYPES[path.extname(relative)];
  if (!type || NOT_SERVED.includes(relative)) return null;
  let real;
  let root;
  try {
    real = fs.realpathSync(path.join(viewDir, ...segments));
    root = fs.realpathSync(viewDir);
  } catch {
    return null;
  }
  if (!real.startsWith(`${root}${path.sep}`) || !fs.statSync(real).isFile()) return null;
  return { file: real, type };
}
