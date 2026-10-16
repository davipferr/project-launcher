// Animated background: a grid of random letters lit by Sasuke's cursed-mark flames, which spread
// out from the top-right corner, hold, recede, and repeat. Ported from char-wave; the flame shapes
// (window.FLAMES, from flames.js) are distance fields cut from a reference image by char-wave's
// tools/extract_flames.py. The canvas sits behind the detail pane and ignores the mouse.
(() => {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const FAMILY = "'Cascadia Mono', Consolas, ui-monospace, monospace";
  const FONT_PX = 11, ROW = 14, LETTER_GAP = 3;   // LETTER_GAP: extra px between letters
  const BL = 16;            // brightness levels (pre-rendered atlases)
  const FPS = 30;           // it's a background: half the frames is plenty

  const MARK_PEAK = 0.45;   // brightness of the flames (0..1)
  const MARK_GRID = 130;    // px between flames: lower = more flames
  const MARK_SIZE = 5;      // screen px per reference px: scales every flame
  const MARK_DENSITY = 0.9; // chance each grid cell gets a flame
  const FLICKER = 0.7;      // reference px the flames sway by, most at the tips
  const SPREAD_IN = 7, HOLD = 5, SPREAD_OUT = 4;   // seconds of each phase of the cycle
  const REACH = 3;          // grid cells beyond the screen edge whose flames can still reach in
  const STRIDE = 5;         // per flame: x, y, scale, flame index, flicker phase

  const { FLAMES, FLAME_UP, FLAME_UNIT } = window;
  const canvas = document.getElementById('flames-bg');
  if (!canvas || !FLAMES) return;
  const ctx = canvas.getContext('2d');
  const FLAME_SDF = FLAMES.map(f => {
    const bin = atob(f.sdf), a = new Int8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  });

  let dpr, W, H, cw, rh, cwd, rhd, pad, slot, cols, rows, N, glyph, atlases;
  let markCols = 0, markRows = 0, markOn, markC, markBox;
  const bins = [];          // per grid cell: the flames whose bounding box overlaps it
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const scheme = matchMedia('(prefers-color-scheme: light)');

  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  // Integer hash -> [0, 1), stable per (x, y, z)
  function hash(x, y, z) {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  // The theme's background and text colors, as [r, g, b]
  function themeColors() {
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    const read = v => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color.match(/\d+/g).slice(0, 3).map(Number); };
    const c = { bg: read('--bg'), text: read('--text') };
    probe.remove();
    return c;
  }

  // Pre-render every char at every brightness so the frame loop is just drawImage calls.
  // Laid out in whole device pixels so glyphs are copied 1:1, with padded slots so wide glyphs aren't clipped.
  function buildAtlases() {
    const { bg, text } = themeColors();
    const fpx = FONT_PX * dpr;
    const m = document.createElement('canvas').getContext('2d');
    m.font = `${fpx}px ${FAMILY}`;
    cwd = Math.round(m.measureText('M').width + (0.5 + LETTER_GAP) * dpr);
    rhd = Math.round(ROW * dpr);
    pad = Math.ceil(cwd / 2);
    slot = cwd + pad * 2;
    cw = cwd / dpr; rh = rhd / dpr;
    atlases = [];
    for (let b = 0; b < BL; b++) {
      const a = document.createElement('canvas');
      a.width = CHARS.length * slot; a.height = rhd;
      const g = a.getContext('2d');
      g.font = `${fpx}px ${FAMILY}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = `rgb(${[0, 1, 2].map(i => Math.round(lerp(bg[i], text[i], b / (BL - 1))))})`;
      for (let i = 0; i < CHARS.length; i++) g.fillText(CHARS[i], i * slot + slot / 2, rhd / 2 + dpr);
      atlases.push(a);
    }
  }

  // The canvas covers only the detail pane (not the project list), following its size and place
  const area = document.getElementById('detail');
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = area.getBoundingClientRect();
    Object.assign(canvas.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    W = canvas.width / dpr; H = canvas.height / dpr;
    buildAtlases();
    cols = Math.ceil(canvas.width / cwd); rows = Math.ceil(canvas.height / rhd); N = cols * rows;
    glyph = new Uint8Array(N);
    for (let i = 0; i < N; i++) glyph[i] = Math.random() * CHARS.length | 0;
  }

  function prepMarks(t) {
    markCols = Math.ceil(W / MARK_GRID) + 2 * REACH; markRows = Math.ceil(H / MARK_GRID) + 2 * REACH;
    const cells = markCols * markRows;
    if (!markOn || markOn.length < cells) {
      markOn = new Uint8Array(cells); markC = new Float32Array(cells * STRIDE); markBox = new Float32Array(cells * 4);
    }

    // How far from the top-right corner the mark has spread, in px
    const cycle = SPREAD_IN + HOLD + SPREAD_OUT, tc = t % cycle, reach = Math.hypot(W, H) + 400;
    const front = reach * (tc < SPREAD_IN + HOLD ? smooth(0, SPREAD_IN, tc) : 1 - smooth(SPREAD_IN + HOLD, cycle, tc));

    for (let gy = 0; gy < markRows; gy++) for (let gx = 0; gx < markCols; gx++) {
      const ci = gy * markCols + gx, cx = gx - REACH, cy = gy - REACH;
      const h = k => hash(cx, cy, k);
      markOn[ci] = 0;
      if (h(1) > MARK_DENSITY) continue;
      const bx = (cx + 0.5 + (h(2) - 0.5) * 0.9) * MARK_GRID, by = (cy + 0.5 + (h(3) - 0.5) * 0.9) * MARK_GRID;
      // Flames near the corner appear first; each one swells in over the 250 px behind the front
      const grow = smooth(front, front - 250, Math.hypot(bx - W, by));
      if (grow < 0.03) continue;
      markOn[ci] = 1;
      const fi = h(4) * FLAMES.length | 0, f = FLAMES[fi];
      const s = MARK_SIZE * (0.8 + 0.45 * h(5)) * grow;
      markC.set([bx, by, s, fi, h(6) * 6.283], ci * STRIDE);
      // The flame's grid, in screen px around its centroid (plus room to sway)
      const sw = s / FLAME_UP, m = FLICKER * s;
      markBox.set([bx - f.cx * sw - m, bx + (f.w - f.cx) * sw + m, by - f.cy * sw - m, by + (f.h - f.cy) * sw + m], ci * 4);
    }

    // Bin each flame into every grid cell its box touches, so a point only checks those flames
    for (let i = 0; i < cells; i++) (bins[i] || (bins[i] = [])).length = 0;
    for (let ci = 0; ci < cells; ci++) {
      if (!markOn[ci]) continue;
      const b = ci * 4;
      const i0 = Math.max(0, Math.floor(markBox[b] / MARK_GRID) + REACH), i1 = Math.min(markCols - 1, Math.floor(markBox[b + 1] / MARK_GRID) + REACH);
      const j0 = Math.max(0, Math.floor(markBox[b + 2] / MARK_GRID) + REACH), j1 = Math.min(markRows - 1, Math.floor(markBox[b + 3] / MARK_GRID) + REACH);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) bins[j * markCols + i].push(ci);
    }
  }

  // One flame's distance field at grid point (gx, gy), bilinear, in reference px (negative inside)
  function sampleFlame(fi, gx, gy) {
    const f = FLAMES[fi], a = FLAME_SDF[fi];
    if (gx < 0 || gy < 0 || gx > f.w - 1 || gy > f.h - 1) return 1e9;
    const x0 = Math.min(f.w - 2, gx | 0), y0 = Math.min(f.h - 2, gy | 0), fx = gx - x0, fy = gy - y0, i = y0 * f.w + x0;
    const top = lerp(a[i], a[i + 1], fx), bot = lerp(a[i + f.w], a[i + f.w + 1], fx);
    return lerp(top, bot, fy) / FLAME_UNIT;
  }

  // Distance to the nearest flame (negative inside) -> brightness
  function field(x, y, t) {
    const gx = Math.floor(x / MARK_GRID) + REACH, gy = Math.floor(y / MARK_GRID) + REACH;
    if (gx < 0 || gy < 0 || gx >= markCols || gy >= markRows) return 0;
    const list = bins[gy * markCols + gx];
    let d = 1e9;
    for (let n = 0; n < list.length; n++) {
      const ci = list[n], bx = ci * 4;
      if (x < markBox[bx] || x > markBox[bx + 1] || y < markBox[bx + 2] || y > markBox[bx + 3]) continue;
      const o = ci * STRIDE, s = markC[o + 2], fi = markC[o + 3], ph = markC[o + 4], f = FLAMES[fi];
      // In reference px from the flame's centroid; sway grows with the distance from it
      let lx = (x - markC[o]) / s, ly = (y - markC[o + 1]) / s;
      const far = Math.min(1, Math.hypot(lx, ly) / 10);
      lx += FLICKER * far * Math.sin(t * 3 + ly * 0.35 + ph);
      ly += FLICKER * 0.6 * far * Math.sin(t * 2.3 + lx * 0.35 + ph * 1.7);
      const dm = sampleFlame(fi, f.cx + lx * FLAME_UP, f.cy + ly * FLAME_UP) * s;
      if (dm < d) d = dm;
    }
    if (d > 5) return 0;
    return MARK_PEAK * smooth(5, -5, d) * (0.75 + 0.25 * smooth(0, -14, d));   // a touch brighter deep inside
  }

  function draw(t) {
    prepMarks(t);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // A few cells change to a different character each frame
    for (let k = 0; k < N * 0.004; k++) {
      const i = Math.random() * N | 0;
      glyph[i] = (glyph[i] + 1 + Math.random() * (CHARS.length - 1)) % CHARS.length | 0;
    }
    for (let r = 0; r < rows; r++) {
      const py = r * rh + rh / 2;
      for (let c = 0; c < cols; c++) {
        const b = field(c * cw + cw / 2, py, t);
        if (b < 0.035) continue;
        const i = r * cols + c;
        ctx.drawImage(atlases[Math.min(BL - 1, b * BL | 0)], glyph[i] * slot, 0, slot, rhd, c * cwd - pad, r * rhd, slot, rhd);
      }
    }
  }

  let last = 0;
  function frame(ms) {
    if (motion.matches) return;   // reduced motion: keep the still frame
    requestAnimationFrame(frame);
    if (ms - last < 1000 / FPS - 2) return;
    last = ms;
    draw(ms / 1000);
  }

  // With reduced motion, show the mark fully spread and hold it still
  function start() {
    if (motion.matches) draw(SPREAD_IN + HOLD / 2);
    else requestAnimationFrame(frame);
  }

  resize();
  const refit = () => { resize(); if (motion.matches) draw(SPREAD_IN + HOLD / 2); };
  new ResizeObserver(refit).observe(area);
  addEventListener('resize', refit);   // the pane can move without changing size
  scheme.addEventListener('change', () => { buildAtlases(); if (motion.matches) draw(SPREAD_IN + HOLD / 2); });
  motion.addEventListener('change', start);
  start();
})();
