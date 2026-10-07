# Idle Bits

Clicker isométrico feito em [PixiJS](https://pixijs.com/) para o site da Scorpion Bits
(<https://scorpionbits.com/jogo/>). Feito para aprender o PixiJS e, de quebra, ter um jogo no site.

## Rodar localmente

```bash
npm install
npm run dev          # http://localhost:5173
```

## Publicação: duas versões

| Onde | Endereço | Como |
| --- | --- | --- |
| **Página do repositório** | <https://scorpionbits.com/idle-game-scorpion/> | Automático: o fluxo `.github/workflows/pages.yml` compila (`npm run build`) e publica a cada push na `main`. |
| **Dentro do site** | <https://scorpionbits.com/jogo/> | Manual: `npm run publish:site` (veja abaixo). Usa o Pixi e as fontes do próprio site. |

Para a primeira vez (só uma vez): **Settings → Pages → Build and deployment → Source = "GitHub Actions"**.
Acompanhe o andamento na aba **Actions**. O Pages só publica a partir da `main`, então é preciso
mesclar a branch de trabalho antes. A versão da página do repositório é autossuficiente (Pixi,
fontes e música vão no build); o `canonical` dela aponta para `/jogo/`, para o Google não indexar duas cópias.

## Como o jogo entra no site

O site (`scorpion-bits.github.io`) é HTML estático, sem build. Por isso o jogo é compilado aqui e o
resultado é **copiado** para a pasta `jogo/` do site. O build do site (`--mode site`) é diferente do
build comum:

- **Não empacota o PixiJS.** Usa o `assets/vendor/pixi.min.js?v=8.22.0` do próprio site (o mesmo do
  easter egg "Rabo de Cubos"), então o navegador baixa o Pixi uma vez só. Se o site atualizar o Pixi,
  confira a versão aqui (`package.json`) e o `src/pixi-global.js`.
- **Usa o cubo do site** (`assets/scorpion_bits_isometric_cube.png`, ver `.env.site`).
- **Casca da página** (título, SEO, fontes Grotesk/Body, tela de carregamento e botão "voltar ao site"):
  injetada pelo plugin `siteHtml` do `vite.config.js`.

### Atualizar o jogo no site

```bash
# com o repositório do site clonado ao lado deste:
npm run publish:site -- ../scorpion-bits.github.io

cd ../scorpion-bits.github.io
git status           # revise: só a pasta jogo/ deve mudar
git add jogo && git commit -m "Atualiza o Idle Bits" && git push
```

## Estrutura

| Arquivo | O que faz |
| --- | --- |
| `src/main.js` | Estado do jogo, lógica e toda a interface |
| `src/data.js` | Upgrades e melhorias |
| `src/skills.js` | As 100 habilidades (mandala) |
| `src/ui.js`, `src/theme.js`, `src/anim.js` | Componentes, tema e animações |
| `src/sfx.js`, `src/music.js`, `src/settings.js` | Sons sintetizados, música em loop e configurações |

O progresso fica no `localStorage` do navegador (`scorpion-bits-idle-v1`); as configurações em
`scorpion-bits-idle-settings`.
