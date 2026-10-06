import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// `npm run build:site` gera a versão que vai para scorpionbits.com/jogo/ (modo "site"):
//  - usa o PixiJS que o site já tem (assets/vendor), sem empacotar outro;
//  - ganha título, SEO, fontes, tela de carregamento e botão "voltar ao site".
const SITE_ORIGIN = 'https://scorpionbits.com';

const siteHtml = () => ({
  name: 'site-html',
  transformIndexHtml(html) {
    return {
      html: html.replace(/<title>.*?<\/title>/, '<title>Idle Bits — jogue no navegador</title>'),
      tags: [
        // `defer`: a tela de carregamento aparece enquanto o Pixi baixa; roda antes do módulo do jogo
        { tag: 'script', attrs: { src: '../assets/vendor/pixi.min.js?v=8.22.0', defer: true }, injectTo: 'head-prepend' },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#05090f' }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'description', content: 'Idle Bits: um clicker isométrico que roda no navegador. Clique no cubo, monte seu estúdio, evolua e explore uma árvore com 100 habilidades.' }, injectTo: 'head' },
        { tag: 'link', attrs: { rel: 'canonical', href: `${SITE_ORIGIN}/jogo/` }, injectTo: 'head' },
        { tag: 'meta', attrs: { property: 'og:type', content: 'website' }, injectTo: 'head' },
        { tag: 'meta', attrs: { property: 'og:url', content: `${SITE_ORIGIN}/jogo/` }, injectTo: 'head' },
        { tag: 'meta', attrs: { property: 'og:title', content: 'Idle Bits — jogue no navegador' }, injectTo: 'head' },
        { tag: 'meta', attrs: { property: 'og:description', content: 'Clique no cubo, monte seu estúdio e evolua. Um clicker isométrico da Scorpion Bits.' }, injectTo: 'head' },
        { tag: 'meta', attrs: { property: 'og:image', content: `${SITE_ORIGIN}/assets/projetos/idle.webp` }, injectTo: 'head' },
        { tag: 'meta', attrs: { property: 'og:locale', content: 'pt_BR' }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' }, injectTo: 'head' },
        { tag: 'link', attrs: { rel: 'icon', href: '../assets/favicon.png', type: 'image/png' }, injectTo: 'head' },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '../assets/favicon.png' }, injectTo: 'head' },
        { tag: 'link', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: '../assets/fonts/grotesk-latin.woff2', crossorigin: '' }, injectTo: 'head' },
        { tag: 'link', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: '../assets/fonts/inter-latin.woff2', crossorigin: '' }, injectTo: 'head' },
        {
          tag: 'style',
          injectTo: 'head',
          children: `
@font-face { font-family: "Grotesk"; src: url("../assets/fonts/grotesk-latin.woff2") format("woff2"); font-weight: 300 700; font-display: swap; }
@font-face { font-family: "Body"; src: url("../assets/fonts/inter-latin.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }
html, body { background: #080e16; }

/* botão "voltar ao site" (canto superior esquerdo, par da engrenagem) */
.back { position: fixed; top: 14px; left: 16px; z-index: 5; width: 36px; height: 36px; border-radius: 50%;
  display: grid; place-items: center; color: #eef5fb; text-decoration: none;
  background: rgba(106, 216, 254, 0.06); border: 1px solid rgba(106, 216, 254, 0.28);
  transition: background .2s, transform .2s, opacity .25s; }
.back:hover, .back:focus-visible { background: rgba(106, 216, 254, 0.16); transform: scale(1.06); outline: none; }
.back svg { width: 18px; height: 18px; }
@media (max-width: 759px) { .back { top: 8px; left: 10px; } }
.modal-open .back { opacity: 0; pointer-events: none; }

/* tela de carregamento: some com fade quando o jogo está pronto */
#boot { position: fixed; inset: 0; z-index: 10; display: grid; place-content: center; justify-items: center; gap: 14px;
  background: #080e16; color: #9db2c6; font: 500 14px/1.4 "Body", "Segoe UI", system-ui, sans-serif;
  transition: opacity .6s ease; }
#boot.done { opacity: 0; pointer-events: none; }
#boot img { width: 56px; height: auto; animation: boot-bob 1.6s ease-in-out infinite; }
#boot p { margin: 0; text-align: center; max-width: 30ch; }
#boot-msg { display: none; }
#boot-msg a { color: #6ad8fe; }
@keyframes boot-bob { 50% { transform: translateY(-6px); } }
@media (prefers-reduced-motion: reduce) { #boot img { animation: none; } }
`,
        },
        {
          tag: 'div',
          attrs: { id: 'boot', role: 'status' },
          injectTo: 'body-prepend',
          children: `<img src="../assets/logo-glyph.png" width="56" height="68" alt="">
<p id="boot-txt">Carregando o jogo…</p>
<p id="boot-msg">Está demorando? Tente recarregar a página ou abrir em outro navegador. <a href="../">Voltar ao site</a></p>
<noscript><p>Este jogo precisa de JavaScript. <a href="../">Voltar ao site</a></p></noscript>`,
        },
        {
          tag: 'a',
          attrs: { class: 'back', href: '../', 'aria-label': 'Voltar ao site da Scorpion Bits', title: 'Voltar ao site' },
          injectTo: 'body-prepend',
          children: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
        },
        {
          tag: 'script',
          injectTo: 'body',
          children: `setTimeout(function(){var m=document.getElementById('boot-msg');if(m&&document.getElementById('boot'))m.style.display='block'},12000)`,
        },
      ],
    };
  },
});

export default defineConfig(({ mode }) => {
  const site = mode === 'site';
  return {
    base: './',
    title: undefined,
    resolve: site
      ? { alias: { 'pixi.js': fileURLToPath(new URL('./src/pixi-global.js', import.meta.url)) } }
      : {},
    plugins: site ? [siteHtml()] : [],
    // no site o cubo vem de assets/ do próprio site, então não copia a pasta public
    publicDir: site ? false : 'public',
    build: { outDir: site ? 'dist-site' : 'dist' },
  };
});
