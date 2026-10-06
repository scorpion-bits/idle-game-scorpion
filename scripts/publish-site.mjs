// Compila o jogo no modo "site" e copia o resultado para <site>/jogo/.
// Uso: npm run publish:site -- ../scorpion-bits.github.io
import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('Informe a pasta do repositório do site.\nEx.: npm run publish:site -- ../scorpion-bits.github.io');
  process.exit(1);
}

const site = resolve(target);
if (!existsSync(resolve(site, 'index.html')) || !existsSync(resolve(site, 'assets/vendor/pixi.min.js'))) {
  console.error(`"${site}" não parece ser o repositório do site (faltam index.html e assets/vendor/pixi.min.js).`);
  process.exit(1);
}

execSync('npx vite build --mode site', { stdio: 'inherit' });

const dest = resolve(site, 'jogo');
rmSync(dest, { recursive: true, force: true });   // tira os arquivos antigos (os nomes têm hash)
cpSync(resolve('dist-site'), dest, { recursive: true });
console.log(`\nJogo copiado para ${dest}\nRevise com "git status" no repositório do site e faça o commit.`);
