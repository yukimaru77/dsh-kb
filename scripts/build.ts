import { build } from 'tsdown';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await build({ cwd: root, entry: ['src/index.ts'], outDir: 'lib', format: 'esm',
  outExtensions: () => ({ js: '.js' }), platform: 'node', target: 'node22',
  sourcemap: true, clean: true, dts: false,
  external: id => !id.startsWith('.') && !id.startsWith('/'),
});
// A package specifier, not a checkout path: the profile installs this package by name.
await writeFile(join(root, 'cordis.patch.yml'), '# Generated bundle overlay.\n- insert:\n    - id: dsh-kb\n      name: dsh-kb\n');
