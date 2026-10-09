// Usado só no build do site (`npm run build:site`): em vez de empacotar o PixiJS de novo,
// o jogo reaproveita o `window.PIXI` carregado de `assets/vendor/pixi.min.js` — o mesmo
// arquivo (e a mesma URL, logo o mesmo cache do navegador) do easter egg "Rabo de Cubos".
// Se o jogo passar a usar outra classe do Pixi, exporte-a aqui também.
const P = window.PIXI;
if (!P) throw new Error('PixiJS não carregou (assets/vendor/pixi.min.js).');

export const { Application, Assets, Sprite, Container, Graphics, Rectangle, Text, ColorMatrixFilter } = P;
export default P;
