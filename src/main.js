import { Application, Assets, Sprite, Text, Container, Graphics } from 'pixi.js';

const app = new Application();
await app.init({ background: '#0b1020', resizeTo: window, antialias: true });
document.body.appendChild(app.canvas);

let bits = 0;
let bitsPerClick = 1;

const upgrades = [
  { id: 'intern', name: 'Estagiário', baseCost: 15,    bps: 0.1, owned: 0 },
  { id: 'junior', name: 'Dev Júnior', baseCost: 100,   bps: 1,   owned: 0 },
  { id: 'lab',    name: 'Game Lab',   baseCost: 1100,  bps: 8,   owned: 0 },
  { id: 'studio', name: 'Estúdio',    baseCost: 12000, bps: 47,  owned: 0 },
];

function costOf(upgrade) {
  return Math.ceil(upgrade.baseCost * 1.15 ** upgrade.owned);
}

function getBps() {
  return upgrades.reduce((sum, u) => sum + u.owned * u.bps, 0);
}

function format(n) {
  if (n < 1000) return Math.floor(n).toString();
  const units = ['K', 'M', 'B', 'T'];
  let i = -1;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return n.toFixed(2) + units[i];
}

function buy(upgrade) {
  const cost = costOf(upgrade);
  if (bits < cost) return;
  bits -= cost;
  upgrade.owned++;
  refreshShop();
}


const texture = await Assets.load('/assets/cube.png');
const cube = new Sprite(texture);
cube.anchor.set(0.5);

const baseScale = 300 / texture.height;
cube.scale.set(baseScale);

cube.eventMode = 'static';
cube.cursor = 'pointer';
app.stage.addChild(cube);


const counter = new Text({
  text: '0 bits',
  style: {
    fill: '#eef5fb',
    fontSize: 48,
    fontFamily: 'Arial',
    fontWeight: 'bold',
  },
});
counter.anchor.set(0.5, 0);
app.stage.addChild(counter);

const bpsText = new Text({
  text: '0 bits/s',
  style: { fill: '#7ee2a8', fontSize: 22, fontFamily: 'Arial' },
});
bpsText.anchor.set(0.5, 0);
app.stage.addChild(bpsText);

const shop = new Container();
app.stage.addChild(shop);

const buttons = [];

upgrades.forEach((u, i) => {
  const btn = new Container();
  btn.y = i * 80;

  const bg = new Graphics()
    .roundRect(0, 0, 260, 70, 12)
    .fill(0x1a2440)
    .stroke({ width: 2, color: 0x6ad8fe });

  const title = new Text({
    text: '',
    style: { fill: '#eef5fb', fontSize: 18, fontFamily: 'Arial', fontWeight: 'bold' },
  });
  title.position.set(12, 8);

  const info = new Text({
    text: '',
    style: { fill: '#b4c6d7', fontSize: 14, fontFamily: 'Arial' },
  });
  info.position.set(12, 38);

  btn.addChild(bg, title, info);
  btn.eventMode = 'static';
  btn.cursor = 'pointer';
  btn.on('pointerdown', () => buy(u));

  shop.addChild(btn);
  buttons.push({ u, btn, title, info });
});

function refreshShop() {
  for (const { u, title, info } of buttons) {
    title.text = `${u.name} (${u.owned})`;
    info.text = `Custo: ${format(costOf(u))} · +${u.bps}/s`;
  }
}
refreshShop();



function layout() {
  cube.position.set(app.screen.width / 2, app.screen.height / 2);
  counter.position.set(app.screen.width / 2, 30);
  bpsText.position.set(app.screen.width / 2, 90);
  shop.position.set(app.screen.width - 290, 120);
}
layout();
app.renderer.on('resize', layout);


cube.on('pointerdown', (event) => {
  bits += bitsPerClick;

  cube.scale.set(baseScale * 0.9);
  spawnFloatingText(event.global.x, event.global.y, `+${bitsPerClick}`);
});


const floaters = [];

function spawnFloatingText(x, y, message) {
  const text = new Text({
    text: message,
    style: { fill: '#6ad8fe', fontSize: 32, fontWeight: 'bold', fontFamily: 'Arial' },
  });
  text.anchor.set(0.5);
  text.position.set(x, y);
  app.stage.addChild(text);
  floaters.push({ text, life: 0 });
}

const FLOAT_DURATION = 800; 

app.ticker.add((ticker) => {
  const dt = ticker.deltaMS;

  bits += getBps() * (dt / 1000);

  counter.text = `${format(bits)} bits`;
  bpsText.text = `${getBps().toFixed(1)} bits/s`;

  for (const { u, btn } of buttons) {
    btn.alpha = bits >= costOf(u) ? 1 : 0.5;
  }

  const s = cube.scale.x + (baseScale - cube.scale.x) * Math.min(1, dt * 0.015);
  cube.scale.set(s);

  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life += dt;
    f.text.y -= dt * 0.08;
    f.text.alpha = 1 - f.life / FLOAT_DURATION;

    if (f.life >= FLOAT_DURATION) {
      app.stage.removeChild(f.text);
      f.text.destroy();
      floaters.splice(i, 1);
    }
  }
});