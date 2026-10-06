// Componentes de interface (Pixi): cartões suaves, botões com micro-interações,
// listas roláveis com entrada em cascata e gavetas laterais com abas.
import { Container, Graphics, Text, Rectangle } from 'pixi.js';
import { C, FONT } from './theme.js';
import { tween, ease } from './anim.js';

export { C, T, hex, darken, lighten } from './theme.js';

export const txt = (text, fill, size, bold = false) => new Text({
  text,
  style: { fill, fontSize: size, fontFamily: FONT, fontWeight: bold ? '600' : '400' },
});

// Cartão arredondado com sombra suave e borda quase invisível.
export function drawCard(g, w, h, {
  fill = C.card, fillAlpha = 1, radius = 16, borderAlpha = 0.07, shadow = true, accent = null,
} = {}) {
  g.clear();
  if (shadow) {
    for (let i = 3; i >= 1; i--) {
      g.roundRect(-i, i * 2.6, w + i * 2, h + i, radius + i).fill({ color: 0x000000, alpha: 0.06 });
    }
  }
  g.roundRect(0, 0, w, h, radius).fill({ color: fill, alpha: fillAlpha })
    .stroke({ width: 1, color: 0xffffff, alpha: borderAlpha });
  if (accent !== null) g.roundRect(0, 14, 3, Math.max(8, h - 28), 1.5).fill(accent);
  return g;
}

// ---------- Botão: cor de destaque suave, realce ao passar o mouse, "afunda" ao apertar ----------
export function makeButton(w, h, { tint = C.accent, radius = 14, alpha = 0.1 } = {}) {
  const c = new Container();
  const inner = new Container();
  const bg = new Graphics();
  const hi = new Graphics();
  inner.addChild(bg, hi);
  Container.prototype.addChild.call(c, inner);
  // todo conteúdo adicionado ao botão vai para `inner`, para escalar junto
  c.addChild = (...children) => inner.addChild(...children);

  c.eventMode = 'static';
  c.cursor = 'pointer';
  const st = { w, h, tint, radius, alpha, active: false };
  c.btn = st;

  c.paint = (over = {}) => {
    Object.assign(st, over);
    bg.clear()
      .roundRect(0, 0, st.w, st.h, st.radius)
      .fill({ color: st.tint, alpha: st.active ? 0.3 : st.alpha })
      .stroke({ width: 1, color: st.tint, alpha: st.active ? 0.75 : 0.28 });
    hi.clear().roundRect(0, 0, st.w, st.h, st.radius).fill({ color: 0xffffff, alpha: 1 });
    inner.pivot.set(st.w / 2, st.h / 2);
    inner.position.set(st.w / 2, st.h / 2);
    c.hitArea = new Rectangle(0, 0, st.w, st.h);
  };
  c.setActive = (on) => c.paint({ active: on });
  c.paint();
  hi.alpha = 0;

  c.on('pointerover', () => {
    tween(hi, { alpha: 0.06 }, 140);
    tween(inner, { scale: 1.025 }, 160);
  });
  c.on('pointerout', () => {
    tween(hi, { alpha: 0 }, 160);
    tween(inner, { scale: 1 }, 180);
  });
  c.on('pointerdown', () => tween(inner, { scale: 0.965 }, 90));
  c.on('pointerup', () => tween(inner, { scale: 1.025 }, 160, { ease: ease.back }));
  c.on('pointerupoutside', () => tween(inner, { scale: 1 }, 160));

  c.inner = inner;
  return c;
}

// ---------- Área rolável (máscara, barra de rolagem e entrada em cascata) ----------
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
      bar.roundRect(s.width + 3, thumbY, 3, thumbH, 1.5).fill({ color: 0xffffff, alpha: 0.18 });
    }
  };

  s.resize = (viewH, w = s.width) => {
    s.viewH = viewH;
    s.width = w;
    maskG.clear().rect(-6, -6, w + 20, viewH + 12).fill(0xffffff);
    s.relayout();
  };

  // entrada em cascata: cada item aparece e desliza um pouco depois do anterior
  s.playIn = (dir = 1) => {
    let i = 0;
    for (const it of s.items) {
      if (!it.c.visible) continue;
      if (i > 12) {
        it.c.alpha = 1;
        it.c.x = 0;
        continue;
      }
      it.c.alpha = 0;
      it.c.x = 22 * dir;
      tween(it.c, { alpha: 1, x: 0 }, 380, { delay: 40 + i * 40 });
      i++;
    }
  };

  return s;
}

// ---------- Gaveta lateral com abas ----------
// As abas ficam na borda da tela. Clicar numa aba abre a gaveta (desliza com fade);
// clicar na aba ativa recolhe; clicar em outra troca a página com entrada em cascata.
export function createDock({ side, panelW, handleW = 34 }) {
  const root = new Container();
  const panel = new Container();
  const panelBg = new Graphics();
  const title = txt('', '#e8eefc', 18, true);
  title.position.set(22, 16);
  const rule = new Graphics();
  const header = new Container();
  const pagesLayer = new Container();
  panel.addChild(panelBg, rule, title, header, pagesLayer);
  const handles = new Container();
  root.addChild(panel, handles);

  const dock = {
    root, side, panelW, header,
    open: true, p: 1, active: 0, tabs: [],
    W: 0, H: 0, top: 90, headerH: 0, onChange: null,
    handleH: 124, handleTop: 24, labelSize: 14,
  };

  const PAGE_TOP = 56;
  const PAD = 14;
  const dir = side === 'right' ? 1 : -1;

  dock.addTab = (name, page, accent) => {
    const h = new Container();
    const bg = new Graphics();
    const label = txt(name, '#93a3c4', 14, true);
    label.anchor.set(0.5);
    label.rotation = side === 'right' ? -Math.PI / 2 : Math.PI / 2;
    h.addChild(bg, label);
    h.eventMode = 'static';
    h.cursor = 'pointer';
    const index = dock.tabs.length;
    h.on('pointertap', () => dock.select(index));
    h.on('pointerover', () => tween(h, { alpha: 0.85 }, 120));
    h.on('pointerout', () => tween(h, { alpha: 1 }, 160));
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
      t.label.style.fill = on ? '#ffffff' : '#93a3c4';
      t.h.hitArea = new Rectangle(0, 0, handleW, dock.handleH);
      t.bg.clear()
        .roundRect(0, 0, handleW, dock.handleH, 14)
        .fill({ color: on ? t.accent : C.panel, alpha: on ? 0.28 : 0.92 })
        .stroke({ width: 1, color: on ? t.accent : 0xffffff, alpha: on ? 0.6 : 0.08 });
      t.page.root.visible = i === dock.active && dock.p > 0.001;
    });
    const tab = dock.tabs[dock.active];
    if (tab) title.text = tab.name;
    if (dock.onChange) dock.onChange();
  };

  const showPage = () => {
    const page = dock.activePage();
    if (!page) return;
    page.root.visible = true;
    page.root.alpha = 1;
    // a página desliza ao entrar; mover o contêiner também força o Pixi a recalcular a
    // máscara da lista (sem isso, a área de clique dos cartões fica no lugar errado)
    page.root.x = PAD + dir * 16;
    tween(page.root, { x: PAD }, 320);
    page.playIn(dir);
  };

  dock.select = (i) => {
    if (!dock.open) {
      dock.open = true;
      dock.active = i;
      dock.paint();
      showPage();
    } else if (i === dock.active) {
      dock.open = false;
      dock.paint();
    } else {
      dock.active = i;
      dock.paint();
      showPage();
    }
  };

  dock.restore = (state) => {
    if (!state) return;
    dock.open = !!state.open;
    dock.p = dock.open ? 1 : 0;
    if (Number.isInteger(state.active) && state.active < dock.tabs.length) dock.active = state.active;
    dock.paint();
  };

  dock.state = () => ({ open: dock.open, active: dock.active });

  dock.activePage = () => dock.tabs[dock.active]?.page;

  dock.setHeader = (container, h) => {
    header.addChild(container);
    container.position.set(PAD, PAGE_TOP - 6);
    dock.headerH = h;
  };

  // tamanho e posição das abas (muda em telas pequenas)
  dock.configure = ({ handleH, handleTop, labelSize }) => {
    dock.handleH = handleH;
    dock.handleTop = handleTop;
    dock.labelSize = labelSize;
    dock.paint();
    dock.position();
  };

  // bottom: até onde a gaveta pode descer (em celular, para antes dos botões de baixo)
  dock.layout = (W, H, top, bottom = H - 14) => {
    dock.W = W;
    dock.H = H;
    dock.top = top;
    const panelH = Math.max(160, bottom - top);
    drawCard(panelBg, panelW, panelH, { fill: C.panel, fillAlpha: 0.97, radius: 22 });
    // fundo estático do painel guardado como textura (sombras translúcidas custam caro a cada quadro)
    if (panelBg.isCachedAsTexture) panelBg.updateCacheTexture();
    else panelBg.cacheAsTexture({ antialias: true });
    rule.clear().moveTo(22, PAGE_TOP - 8).lineTo(panelW - 22, PAGE_TOP - 8)
      .stroke({ width: 1, color: 0xffffff, alpha: 0.06 });
    const pageTop = PAGE_TOP + dock.headerH;
    for (const t of dock.tabs) {
      t.page.resize(panelH - pageTop - 16);
      t.page.root.y = pageTop;
    }
    dock.panelH = panelH;
    dock.position();
  };

  dock.position = () => {
    const e = ease.out(dock.p);
    const openX = side === 'right' ? dock.W - panelW - 14 : 10;
    const closedX = side === 'right' ? dock.W - 6 : -panelW + 6;
    const x = closedX + (openX - closedX) * e;
    panel.position.set(x, dock.top);
    panel.alpha = Math.min(1, e * 1.4);
    panel.visible = dock.p > 0.001;
    handles.x = side === 'right' ? x - handleW - 6 : x + panelW + 6;
    handles.y = dock.top + dock.handleTop;
    dock.tabs.forEach((t, i) => { t.h.y = i * (dock.handleH + 10); });
  };

  dock.update = (dt) => {
    const target = dock.open ? 1 : 0;
    if (dock.p !== target) {
      dock.p = Math.min(1, Math.max(0, dock.p + (target ? 1 : -1) * (dt / 320)));
      if (dock.p === 0) dock.paint();
    }
    dock.position();
  };

  dock.hit = (px, py) => dock.p > 0.5
    && px >= panel.x && px <= panel.x + panelW
    && py >= dock.top && py <= dock.top + (dock.panelH ?? 0);

  return dock;
}
