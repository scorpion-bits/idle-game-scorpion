import { Application, Assets, Sprite } from "pixi.js";

const app = new Application();

await app.init({
  background: '#0b1020',
  resizeTo: window,
  antialias: true,
});


document.body.appendChild(app.canvas);

const texture = await Assets.load('/assets/cube.png');
const cube = new Sprite(texture);

cube.anchor.set(0.5);
cube.x = app.screen.width / 2;
cube.y = app.screen.height / 2;
cube.height = 200;
cube.scale.x = cube.scale.y;

app.stage.addChild(cube);