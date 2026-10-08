// Builds dist/slop-teller-v<version>.zip with only what the browser needs.
//   node tools/build-zip.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const dist = path.join(ROOT, 'dist');
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, `slop-teller-v${version}.zip`);
fs.rmSync(out, { force: true });
// git archive gives a clean zip of tracked files only, so local test output never slips in.
execFileSync('git', ['archive', '--format=zip', '--prefix=slop-teller/', '-o', out, 'HEAD', 'manifest.json', 'src', 'icons', 'hook', 'LICENSE', 'README.md'], { cwd: ROOT });
console.log(out);
