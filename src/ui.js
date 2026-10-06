// Helpers de interface (Pixi): estilo "laje isométrica", rolagem e gavetas laterais com abas.
import { Container, Graphics, Text } from 'pixi.js';

export const FONT = 'Arial';

export const txt = (text, fill, size, bold = false) => new Text({
  text,
  style: { fill, fontSize: size, fontFamily: FONT, fontWeight: bold ? 'bold' : 'normal' },
});

const channel = (c, shift) => (c >> shift) & 0xff;
const pack = (r, g, b) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);

export function darken(color, f) {
  return pack(channel(color, 16) * (1 - f), channel(color, 8) * (1 - f), channel(color, 0) * (1 - f));
}

export function lighten(color, f) {
  const up = (v) => v + (255 - v) * f;
  return pack(up(channel(color, 16)), up(channel(color, 8)), up(channel(color, 0)));
}

export const hex = (color) => `#${color.toString(16).padStart(6, '0')}`;

// Laje com extrusão para baixo/direita (lembra um bloco isométrico) e cantos cortados.
export function drawSlab(g, w, h, { face = 0x1a2440, edge = 0x3a4a63, depth = 4, cut = 8, edgeAlpha = 1 } = {}) {
  const poly = (ox, oy) => [
    cut + ox, oy, w + ox, oy, w + ox, h - cut + oy, w - cut + ox, h + oy, ox, h + oy, ox, cut + oy,
  ];
  const side = darken(face, 0.5);
  g.clear();
  for (let i = depth; i >= 1; i--) g.poly(poly(i * 0.9, i)).fill(side);
  g.poly(poly(0, 0)).fill(face).stroke({ width: 1.5, color: edge, alpha: edgeAlpha });
  g.moveTo(cut + 2, 1.5).lineTo(w - 2, 1.5).stroke({ width: 1, color: 0xffffff, alpha: 0.1 });
  return g;
}

export function makeSlabButton(w, h, face, edge, opts = {}) {
  const c = new Container();
  const bg = new Graphics();
  c.addChild(bg);
  c.slab = { w, h, face, edge, ...opts };
  c.paint = (over = {}) => {
    Object.assign(c.slab, over);
    drawSlab(bg, c.slab.w, c.slab.h, c.slab);
  };
  c.paint();
  c.eventMode = 'static';
  c.cursor = 'pointer';
  return c;
}

// ---------- Área rolável (com máscara e barra de rolagem) ----------
export function createScroll(width) {
  const root = new Container();
  const content = new Container();
  const maskG = new Graphics();
  const bar = new Graphics();
  root.addChild(content, maskG, bar);
  content.mask = maskG;

  const s = { root, content, width, viewH: 300, scrollY: 0, contentH: 0, items: [] };

  s.add = (c, h) => {
    content.addChild(c);
    s.items.push({ c, h });
    return c;
  };

  s.relayout = () => {
    let y = 0;
    for (const it of s.items) {
      if (!it.c.visible) continue;
      it.c.y = y;
      y += it.h + 8;
    }
    s.contentH = y;
    s.scrollBy(0);
  };

  s.scrollBy = (dy) => {
    const max = Math.max(0, s.contentH - s.viewH);
    s.scrollY = Math.min(max, Math.max(0, s.scrollY + dy));
    content.y = -s.scrollY;
    bar.clear();
    if (max > 0) {
      const thumbH = Math.max(30, (s.viewH * s.viewH) / s.contentH);
      const thumbY = (s.scrollY / max) * (s.viewH - thumbH);
      bar.roundRect(s.width + 2, thumbY, 4, thumbH, 2).fill({ color: 0x6ad8fe, alpha: 0.5 });
    }
  };

  s.resize = (viewH, w = s.width) => {
    s.viewH = viewH;
    s.width = w;
    maskG.clear().rect(-4, -4, w + 16, viewH + 8).fill(0xffffff);
    s.relayout();
  };

  return s;
}

// ---------- Gaveta lateral com abas ----------
// As abas ficam coladas na borda da tela. Clicar numa aba abre a gaveta (desliza para dentro);
// clicar na aba ativa recolhe a gaveta; clicar em outra troca o conteúdo.
const easeOut = (t) => 1 - (1 - t) ** 3;

export function createDock({ side, panelW, handleW = 38 }) {
  const root = new Container();
  const panel = new Container();
  const panelBg = new Graphics();
  const title = txt('', '#eef5fb', 20, true);
  title.position.set(18, 14);
  const header = new Container();
  const pagesLayer = new Container();
  panel.addChild(panelBg, title, header, pagesLayer);
  const handles = new Container();
  root.addChild(panel, handles);

  const dock = {
    root, side, panelW, header,
    open: true, p: 1, fade: 1, active: 0, tabs: [],
    W: 0, H: 0, top: 90, headerH: 0, onChange: null,
    handleH: 124, handleTop: 24, labelSize: 15,
  };

  const PAGE_TOP = 54;
  const PAD = 14;

  dock.addTab = (name, page, accent) => {
    const h = new Container();
    const bg = new Graphics();
    const label = txt(name, '#b4c6d7', 15, true);
    label.anchor.set(0.5);
    label.rotation = side === 'right' ? -Math.PI / 2 : Math.PI / 2;
    h.addChild(bg, label);
    h.eventMode = 'static';
    h.cursor = 'pointer';
    const index = dock.tabs.length;
    h.on('pointertap', () => dock.select(index));
    handles.addChild(h);

    page.root.position.set(PAD, PAGE_TOP);
    page.root.visible = false;
    pagesLayer.addChild(page.root);

    dock.tabs.push({ name, page, accent, bg, label, h });
    dock.paint();
  };

  dock.setLabel = (i, text) => { dock.tabs[i].label.text = text; };

  dock.paint = () => {
    dock.tabs.forEach((t, i) => {
      const on = dock.open && i === dock.active;
      t.label.position.set(handleW / 2, dock.handleH / 2);
      t.label.style.fontSize = dock.labelSize;
      drawSlab(t.bg, handleW, dock.handleH, {
        face: on ? 0x1f2c52 : 0x111a33,
        edge: on ? t.accent : 0x3a4a63,
        depth: 4,
        cut: 10,
      });
      t.label.style.fill = on ? '#ffffff' : '#9fb3c8';
      t.page.root.visible = on || (i === dock.active && dock.p > 0.001);
    });
    const tab = dock.tabs[dock.active];
    if (tab) title.text = tab.name;
    if (dock.onChange) dock.onChange();
  };

  dock.select = (i) => {
    if (!dock.open) {
      dock.open = true;
      dock.active = i;
      dock.fade = 0;
    } else if (i === dock.active) {
      dock.open = false;
    } else {
      dock.active = i;
      dock.fade = 0;
    }
    dock.paint();
  };

  dock.restore = (state) => {
    if (!state) return;
    dock.open = !!state.open;
    dock.p = dock.open ? 1 : 0;
    if (Number.isInteger(state.active) && state.active < dock.tabs.length) dock.active = state.active;
    dock.paint();
  };

  dock.state = () => ({ open: dock.open, active: dock.active });

  // tamanho e posição das abas (muda em telas pequenas)
  dock.configure = ({ handleH, handleTop, labelSize }) => {
    dock.handleH = handleH;
    dock.handleTop = handleTop;
    dock.labelSize = labelSize;
    dock.paint();
    dock.position();
  };

  dock.activePage = () => dock.tabs[dock.active]?.page;

  dock.setHeader = (container, h) => {
    header.addChild(container);
    container.position.set(PAD, PAGE_TOP - 4);
    dock.headerH = h;
  };

  // bottom: até onde a gaveta pode descer (em celular, para antes dos botões de baixo)
  dock.layout = (W, H, top, bottom = H - 14) => {
    dock.W = W;
    dock.H = H;
    dock.top = top;
    const panelH = Math.max(160, bottom - top);
    drawSlab(panelBg, panelW, panelH, { face: 0x0e1630, edge: 0x2c4a66, depth: 6, cut: 20 });
    const pageTop = PAGE_TOP + dock.headerH;
    for (const t of dock.tabs) t.page.resize(panelH - pageTop - 14);
    for (const t of dock.tabs) t.page.root.y = pageTop;
    dock.panelH = panelH;
    dock.position();
  };

  dock.position = () => {
    const e = easeOut(dock.p);
    const openX = side === 'right' ? dock.W - panelW - 14 : 10;
    const closedX = side === 'right' ? dock.W - 4 : -panelW + 4;
    const x = closedX + (openX - closedX) * e;
    panel.position.set(x, dock.top);
    panel.visible = dock.p > 0.001;
    handles.x = side === 'right' ? x - handleW + 4 : x + panelW - 4;
    handles.y = dock.top + dock.handleTop;
    dock.tabs.forEach((t, i) => { t.h.y = i * (dock.handleH + 12); });
  };

  dock.update = (dt) => {
    const target = dock.open ? 1 : 0;
    if (dock.p !== target) {
      dock.p = Math.min(1, Math.max(0, dock.p + (target ? 1 : -1) * (dt / 280)));
      if (dock.p === 0) dock.paint();
    }
    if (dock.fade < 1) dock.fade = Math.min(1, dock.fade + dt / 220);
    const page = dock.activePage();
    if (page) {
      const f = easeOut(dock.fade);
      page.root.alpha = f;
      page.root.x = PAD + (1 - f) * (side === 'right' ? 28 : -28);
    }
    dock.position();
  };

  dock.hit = (px, py) => dock.p > 0.5
    && px >= panel.x && px <= panel.x + panelW
    && py >= dock.top && py <= dock.top + (dock.panelH ?? 0);

  return dock;
}
