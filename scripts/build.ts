import { build } from 'tsdown';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await build({ cwd: root, entry: ['src/index.ts'], outDir: 'lib', format: 'esm',
  outExtensions: () => ({ js: '.js' }), platform: 'node', target: 'node24',
  sourcemap: true, clean: true, dts: false,
  external: id => !id.startsWith('.') && !id.startsWith('/'),
});
await writeFile(join(root, 'cordis.patch.yml'), `# Generated for this checkout; rebuild after moving it.\n- insert:\n    - id: dsh-kb\n      name: ${JSON.stringify(join(root, 'lib/index.js'))}\n`);
