// Helpers for the tests (not a test file itself: npm test runs test/*.test.mjs).
import fs from 'node:fs';
import path from 'node:path';

/**
 * Removes a temporary folder the tests made, read-only files included (git's objects are read-only on
 * Windows, and Electron's Node 24.22 fs.rmSync gives EPERM on them), and never fails the test run over it:
 * a folder that can't be removed is reported and left (it is in the temp folder).
 */
export function removeTree(dir) {
  const writable = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    // a link (a worktree's node_modules junction) is taken out itself, never followed: Electron's Node 24.22
    // fs.rmSync leaves a folder holding a junction in place without an error
    if (st.isSymbolicLink()) {
      try {
        fs.unlinkSync(p);
      } catch {
        fs.rmdirSync(p);
      }
      return;
    }
    try {
      fs.chmodSync(p, st.isDirectory() ? 0o777 : 0o666);
    } catch {
      // try anyway
    }
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) writable(path.join(p, n));
  };
  try {
    writable(dir);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    if (fs.existsSync(dir)) throw new Error('still there');
  } catch (e) {
    console.warn(`could not remove ${dir}: ${e.code || e.message}`);
  }
}
