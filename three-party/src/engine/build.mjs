// The build the three-party demo runs from: the commit of the git clone it
// is started in or, in a copy made by scripts/three-party/package.sh (which
// has no git directory), the commit that script wrote to
// three-party/BUILD.txt.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, buildInfo } from '../../../src/build-info.mjs';

export const BUILD_FILE = 'three-party/BUILD.txt';
const COMMIT_LINE = /^commit ([0-9a-f]{40})$/m;

// { sha7, modified, source }. source is 'git' for a git clone, 'build-file'
// for a packaged copy, and null when the tree is neither: then sha7 is null.
export function demoBuild(root = ROOT) {
  const info = buildInfo(root);
  if (info.fromGit) return Object.freeze({ sha7: info.sha7, modified: info.modified, source: 'git' });
  try {
    const named = COMMIT_LINE.exec(fs.readFileSync(path.join(root, BUILD_FILE), 'utf8'));
    if (named) return Object.freeze({ sha7: named[1].slice(0, 7), modified: false, source: 'build-file' });
  } catch {
    // No build file: this tree is not a packaged copy.
  }
  return Object.freeze({ sha7: null, modified: null, source: null });
}

// The build as a line of the command line names it: the short sha, the
// short sha with "(modified)" for a clone with changes, or the words for a
// tree that names no commit.
export function demoBuildWords(build = demoBuild()) {
  if (build.sha7 === null) return 'not from a git clone';
  return build.modified ? `${build.sha7} (modified)` : build.sha7;
}
