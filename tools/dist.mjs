// Builds the Windows installer (npm run dist).
// electron is an optional dependency so that `npm i -g` from the repository brings it along (the npm
// install, see bin/fleet-bridge.cjs). electron-builder refuses electron outside devDependencies and
// would also pack its 250 MB into the app, so for the build it is moved back to devDependencies, and
// package.json is restored afterwards whatever happens.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'package.json');
const original = fs.readFileSync(FILE, 'utf8');
const pkg = JSON.parse(original);
const v = pkg.optionalDependencies?.electron;
if (v) {
  delete pkg.optionalDependencies.electron;
  if (!Object.keys(pkg.optionalDependencies).length) delete pkg.optionalDependencies;
  pkg.devDependencies = { ...pkg.devDependencies, electron: v };
  fs.writeFileSync(FILE, JSON.stringify(pkg, null, 2) + '\n');
}
let status = 1;
try {
  const r = spawnSync('npx', ['electron-builder', '--win', 'nsis', ...process.argv.slice(2)], { cwd: ROOT, stdio: 'inherit', shell: true });
  status = r.status ?? 1;
} finally {
  fs.writeFileSync(FILE, original);
}
process.exit(status);
