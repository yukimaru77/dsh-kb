import { access, lstat, mkdir, readdir, realpath, symlink, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const supplied = process.argv[2] ?? process.env.DSH_PI_COMPAT_SOURCE;
if (!supplied || process.argv.length > 3) {
  console.error('Usage: node scripts/bootstrap.mjs /path/to/built/dsh-pi-compat');
  process.exit(1);
}
const compat = await realpath(resolve(supplied));
await access(join(compat, 'lib/index.js'));
const links = new Map([['dsh-pi-compat', compat]]);
for (const scope of ['@deepseek-ai', '@earendil-works', '@types']) {
  for (const name of await readdir(join(compat, 'node_modules', scope))) {
    links.set(`${scope}/${name}`, join(compat, 'node_modules', scope, name));
  }
}
for (const name of ['tsx', 'tsdown', 'typescript', 'js-yaml']) {
  links.set(name, join(compat, 'node_modules', name));
}
for (const [name, target] of links) {
  await access(target);
  const destination = join(root, 'node_modules', name);
  const stat = await lstat(destination).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (stat && !stat.isSymbolicLink()) throw new Error(`Refusing to replace installed directory: ${destination}`);
}
for (const [name, target] of links) {
  const destination = join(root, 'node_modules', name);
  await mkdir(dirname(destination), { recursive: true });
  await unlink(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await symlink(target, destination, 'junction');
}
console.log('Linked local development dependencies. Run npm run build, npm run typecheck, and npm test.');
