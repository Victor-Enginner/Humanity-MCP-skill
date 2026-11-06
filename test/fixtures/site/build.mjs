import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
const root = dirname(new URL(import.meta.url).pathname.slice(1));
const required = ['index.html', 'styles/base.css', 'styles/tokens.css'];
for (const f of required) {
  if (!existsSync(join(root, f))) { console.error(`faltando: ${f}`); process.exit(1); }
  if (join(root, f).endsWith('.css') && /#[0-9a-fA-F]{6}/.test(readFileSync(join(root, f), 'utf8')) && !f.includes('tokens')) {
    console.error(`cor literal fora de tokens em ${f}`); process.exit(1);
  }
}
console.log('build ok');
