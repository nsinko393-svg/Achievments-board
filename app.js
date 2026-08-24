/* =========================================================
   Achievement Board — логіка
   0) конфіг      1) стан+сховище   1.5) спільна дошка (Firebase)
   2) DOM         3) рендер         4) вʼюпорт    5) інструменти
   6) події поля  6.5) тач/жести    7) стрілки    8) меню
   9) модалки     10) панелі/адаптив/старт
   ========================================================= */
'use strict';

/* ---------------- 0) КОНФІГ ---------------- */
const STORE_KEY = 'ab.board.v2';
const THEME_KEY = 'ab.theme';
const NODE_R    = 54;      // радіус орба у світових координатах
const MIN_Z     = 0.15;
const MAX_Z     = 2.6;

/* Категорії задають колір ачівки. Додавай свої — вони одразу зʼявляться у формах і фільтрі. */
const CATEGORIES = {
  personal: { label: 'Особисте',  color: '#7c9cff' },
  work:     { label: 'Робоче',    color: '#ffb545' },
  learning: { label: 'Навчання',  color: '#c084fc' },
  health:   { label: 'Здоровʼя',  color: '#4ade80' },
  finance:  { label: 'Фінанси',   color: '#38d9c9' },
  other:    { label: 'Інше',      color: '#94a3b8' },
};
const STATUSES = { locked: 'Заблоковано', progress: 'В процесі', done: 'Отримано' };

const ICONS = ['⭐','🏆','🥇','🎖','👑','💎','🔥','🚀','🎯','🧠','💪','❤️','📚','🎓','💻','⌨️','🧩','📈','💰','🏦',
               '🛠','🔨','⚔️','🛡','🏹','🧭','🗺','🏔','🏃','🧘','🥋','🚴','🏊','🍎','😴','🌱','🌍','✈️','🎸','🎨',
               '🎬','🎤','📷','✍️','📝','🗣','🤝','👔','📊','🧾','⚙️','🔬','🧪','🤖','🌐','🔑','⏱','🕒','🎁','🍀'];

/* ---------------- 1) СТАН + СХОВИЩЕ ---------------- */
let state = { name: 'Мій роадмеп', nodes: [], edges: [], view: { x: 0, y: 0, scale: 1 } };
const view = state.view;

let tool        = 'select';
let selection   = new Set();   // id ачівок
let selEdge     = null;        // id стрілки
let spaceDown   = false;
let linkFrom    = null;        // режим "клік-стрілка": id джерела
let cursorWorld = { x: 0, y: 0 };
let activeDrag  = null;        // поточне перетягування — щоб перервати його жестом
let pinch       = null;        // стан зуму двома пальцями
const filter    = { q: '', cats: new Set(Object.keys(CATEGORIES)), stats: new Set(Object.keys(STATUSES)) };

const past = [], future = [];
const snapshot = () => JSON.stringify({ nodes: state.nodes, edges: state.edges });
function restore(json) {
  const d = JSON.parse(json);
  state.nodes = d.nodes; state.edges = d.edges;
  selection.clear(); selEdge = null;
  render();
}
/** Будь-яка зміна даних — через це. Дає undo/redo + автозбереження. */
function withHistory(fn) {
  const before = snapshot();
  const r = fn();
  past.push(before); if (past.length > 100) past.shift();
  future.length = 0;
  render(); saveSoon();
  return r;
}
function undo() {
  if (!past.length) return toast('Нічого відміняти');
  future.push(snapshot()); restore(past.pop()); saveSoon();
}
function redo() {
  if (!future.length) return toast('Нічого повторювати');
  past.push(snapshot()); restore(future.pop()); saveSoon();
}

let saveTimer = null;
function saveSoon() {
  $('#saveState').textContent = remote ? 'синхронізація…' : 'збереження…';
  $('#saveState').classList.add('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* приватний режим */ }
    pushRemote();
    paintSaveState();
    $('#saveState').classList.remove('saving');
  }, 350);
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    state.name  = d.name || 'Мій роадмеп';
    state.nodes = (d.nodes || []).map(normalizeNode);
    state.edges = (d.edges || []).filter(e => e && e.from && e.to);
    Object.assign(view, d.view || {});
    return true;
  } catch (e) { return false; }
}
function normalizeNode(n) {
  return {
    id: n.id || uid(), x: +n.x || 0, y: +n.y || 0,
    title: n.title || 'Без назви', icon: n.icon || '⭐',
    category: CATEGORIES[n.category] ? n.category : 'other',
    status: STATUSES[n.status] ? n.status : 'locked',
    desc: n.desc || '',
    milestones: (n.milestones || []).map(m => ({ id: m.id || uid(), text: m.text || '', done: !!m.done })),
  };
}

/* ---------------- 1.5) СПІЛЬНА ДОШКА (Firebase) ----------------
   Один документ Firestore — одна дошка на всіх користувачів.
   Ключі беруться з firebase-config.js; без них (плейсхолдери) або
   без інтернету застосунок сам лишається у режимі "тільки цей браузер".
   Синхронізуються лише name/nodes/edges — панорама/зум залишаються
   особистими для кожного пристрою. */
const FIREBASE_DOC = { col: 'boards', id: 'shared' };
let remote        = null;   // посилання на документ Firestore, якщо підключення вдалося
let connOk        = null;   // null — офлайн-режим не налаштований, true/false — стан звʼязку
let lastRemoteJSON = null;  // щоб не застосовувати echo власного запису як "чужу" зміну

function sharedJSON() {
  return JSON.stringify({ name: state.name, nodes: state.nodes, edges: state.edges });
}
function paintSaveState() {
  $('#saveState').textContent = !remote ? 'збережено'
    : connOk === true ? 'синхронізовано' : connOk === false ? 'офлайн (локально)' : 'зʼєднання…';
}
function pushRemote() {
  if (!remote) return;
  const json = sharedJSON();
  if (json === lastRemoteJSON) return;   // нічого спільного не змінилось (напр. лише панорама)
  lastRemoteJSON = json;
  remote.set(JSON.parse(json)).catch(() => { connOk = false; paintSaveState(); });
}
function initRemote() {
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || cfg.apiKey === 'ВСТАВ_СЮДИ' || !window.firebase) return;   // не налаштовано — локальний режим
  try {
    firebase.initializeApp(cfg);
    remote = firebase.firestore().collection(FIREBASE_DOC.col).doc(FIREBASE_DOC.id);
  } catch (e) { remote = null; return; }

  let announced = false;
  remote.onSnapshot(snap => {
    connOk = true; paintSaveState();
    if (!announced) { announced = true; toast('Підключено до спільної дошки'); }
    const d = snap.data();
    if (!d) { pushRemote(); return; }          // документа ще нема — створюємо його з поточного стану
    const incoming = JSON.stringify({ name: d.name, nodes: d.nodes || [], edges: d.edges || [] });
    if (incoming === lastRemoteJSON) return;   // це наш власний запис, що повернувся
    lastRemoteJSON = incoming;
    state.name  = d.name || state.name;
    state.nodes = (d.nodes || []).map(normalizeNode);
    state.edges = (d.edges || []).filter(e => e && e.from && e.to);
    selection.clear(); selEdge = null;
    $('#boardName').value = state.name;
    render();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* приватний режим */ }
  }, () => { connOk = false; paintSaveState(); toast('Немає звʼязку зі спільною дошкою — працюємо локально'); });
}

/* ---------------- 2) DOM ---------------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const viewportEl = $('#viewport');
const canvas     = $('#canvas');
const world      = $('#world');
const nodesEl    = $('#nodes');
const edgeLayer  = $('#edgeLayer');
const tempLayer  = $('#tempLayer');
const ctxmenu    = $('#ctxmenu');
const modalRoot  = $('#modalRoot');
const tplNode    = $('#tplNode');

const getNode = id => state.nodes.find(n => n.id === id);
const getEdge = id => state.edges.find(e => e.id === id);

/* ---------------- 3) РЕНДЕР ---------------- */
function render() { renderNodes(); renderEdges(); renderStats(); }

function renderNodes() {
  nodesEl.textContent = '';
  const frag = document.createDocumentFragment();
  for (const n of state.nodes) {
    const el = tplNode.content.firstElementChild.cloneNode(true);
    el.dataset.id = n.id;
    paintNode(el, n);
    frag.appendChild(el);
  }
  nodesEl.appendChild(frag);
  applyFilter();
}

function paintNode(el, n) {
  const cat = CATEGORIES[n.category] || CATEGORIES.other;
  el.style.left = n.x + 'px';
  el.style.top  = n.y + 'px';
  el.dataset.status = n.status;
  el.style.setProperty('--accent', cat.color);
  el.style.setProperty('--p', progressPct(n));
  el.querySelector('.orb-icon').textContent   = n.icon || '⭐';
  el.querySelector('.node-label').textContent = n.title || 'Без назви';
  const total = n.milestones.length, done = n.milestones.filter(m => m.done).length;
  el.querySelector('.node-meta').textContent = total ? `${done}/${total}` : (n.status === 'done' ? '✓' : '');
  el.classList.toggle('sel', selection.has(n.id));
}
const nodeEl = id => nodesEl.querySelector(`.node[data-id="${id}"]`);

function progressPct(n) {
  if (n.status === 'done') return 100;
  const t = n.milestones.length;
  if (!t) return n.status === 'progress' ? 10 : 0;
  return Math.round(n.milestones.filter(m => m.done).length / t * 100);
}

/* --- стрілки --- */
const edgeEls = new Map();
function renderEdges() {
  edgeLayer.textContent = ''; edgeEls.clear();
  const frag = document.createDocumentFragment();
  for (const e of state.edges) {
    if (!getNode(e.from) || !getNode(e.to)) continue;
    const g    = svgEl('g', { 'data-id': e.id });
    const hit  = svgEl('path', { class: 'edge-hit' });
    const path = svgEl('path', { class: 'edge', 'marker-end': 'url(#ah)' });
    g.append(hit, path);
    let label = null;
    if (e.label) { label = svgEl('text', { class: 'edge-label' }); label.textContent = e.label; g.append(label); }
    frag.appendChild(g);
    edgeEls.set(e.id, { g, path, hit, label });
  }
  edgeLayer.appendChild(frag);
  updateEdgePaths();
}

function updateEdgePaths() {
  for (const e of state.edges) {
    const refs = edgeEls.get(e.id); if (!refs) continue;
    const a = getNode(e.from), b = getNode(e.to); if (!a || !b) continue;
    const g = geom(a, b);
    refs.path.setAttribute('d', g.d);
    refs.hit.setAttribute('d', g.d);
    refs.path.setAttribute('class', 'edge'
      + (b.status === 'done' ? ' to-done' : b.status === 'locked' ? ' to-locked' : '')
      + (selEdge === e.id ? ' sel' : ''));
    refs.path.setAttribute('marker-end', selEdge === e.id ? 'url(#ah-sel)' : 'url(#ah)');
    if (refs.label) { refs.label.setAttribute('x', g.mx); refs.label.setAttribute('y', g.my - 6); }
  }
}

/** Дуга від краю до краю кола + точка для підпису. */
function geom(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d  = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  const sx = a.x + ux * (NODE_R + 4), sy = a.y + uy * (NODE_R + 4);
  const ex = b.x - ux * (NODE_R + 14), ey = b.y - uy * (NODE_R + 14);
  const bow = Math.min(70, d * 0.16);
  const cx = (sx + ex) / 2 - uy * bow, cy = (sy + ey) / 2 + ux * bow;
  return {
    d: `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`,
    mx: (sx + 2 * cx + ex) / 4,
    my: (sy + 2 * cy + ey) / 4,
  };
}

function renderStats() {
  const total = state.nodes.length;
  const done  = state.nodes.filter(n => n.status === 'done').length;
  $('#progressChip .chip-txt').textContent = `${done}/${total}`;
  $('#progressChip .chip-bar i').style.width = (total ? done / total * 100 : 0) + '%';
  $('#btnUndo').disabled = !past.length;
  $('#btnRedo').disabled = !future.length;
}

/* --- фільтр/пошук --- */
function applyFilter() {
  const q = filter.q.trim().toLowerCase();
  for (const n of state.nodes) {
    const el = nodeEl(n.id); if (!el) continue;
    const inCat = filter.cats.has(n.category);
    const inSt  = filter.stats.has(n.status);
    const hit   = !!q && (n.title + ' ' + n.desc + ' ' + n.milestones.map(m => m.text).join(' '))
                          .toLowerCase().includes(q);
    el.classList.toggle('dim', !inCat || !inSt || (!!q && !hit));
    el.classList.toggle('hit', hit);
  }
}

/* ---------------- 4) ВʼЮПОРТ ---------------- */
function applyView() {
  world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.scale})`;
  const g = 28 * view.scale;
  canvas.style.backgroundSize     = `${g}px ${g}px`;
  canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
  $('#zoomVal').textContent = Math.round(view.scale * 100) + '%';
}
function zoomAt(sx, sy, s) {
  s = clamp(s, MIN_Z, MAX_Z);
  const wx = (sx - view.x) / view.scale, wy = (sy - view.y) / view.scale;
  view.scale = s; view.x = sx - wx * s; view.y = sy - wy * s;
  applyView(); saveSoon();
}
function zoomCenter(f) {
  const r = viewportEl.getBoundingClientRect();
  zoomAt(r.width / 2, r.height / 2, view.scale * f);
}
function resetView() { view.x = 0; view.y = 0; view.scale = 1; applyView(); saveSoon(); }

function fitView() {
  if (!state.nodes.length) return resetView();
  const pad = 140;
  const xs = state.nodes.map(n => n.x), ys = state.nodes.map(n => n.y);
  const x1 = Math.min(...xs) - pad, x2 = Math.max(...xs) + pad;
  const y1 = Math.min(...ys) - pad, y2 = Math.max(...ys) + pad;
  const r = viewportEl.getBoundingClientRect();
  const s = clamp(Math.min(r.width / (x2 - x1), r.height / (y2 - y1)), MIN_Z, 1.4);
  view.scale = s;
  view.x = r.width / 2 - (x1 + x2) / 2 * s;
  view.y = r.height / 2 - (y1 + y2) / 2 * s;
  applyView(); saveSoon();
}

/** екран (clientX/Y) -> світ */
function toWorld(cx, cy) {
  const r = viewportEl.getBoundingClientRect();
  return { x: (cx - r.left - view.x) / view.scale, y: (cy - r.top - view.y) / view.scale };
}
/** світ -> екран (clientX/Y) */
function toScreen(x, y) {
  const r = viewportEl.getBoundingClientRect();
  return { x: r.left + view.x + x * view.scale, y: r.top + view.y + y * view.scale };
}

/* ---------------- 5) ІНСТРУМЕНТИ ---------------- */
/* Щоб додати свій інструмент: кнопка в index.html з data-tool="name",
   курсор у styles.css (#canvas.t-name) і обробка у onCanvasDown(). */
function setTool(t) {
  tool = t;
  cancelLink();
  $$('.tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  canvas.className = 't-' + t;
}
$$('.tool[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
$$('.tool.soon').forEach(b => b.addEventListener('click', () =>
  toast(`Інструмент «${b.dataset.soon}» — заготовка. Логіку додай у app.js (розділ 5).`)));
$('#btnFit').addEventListener('click', fitView);

/* ---------------- 6) ПОДІЇ ПОЛЯ ---------------- */
/* ПКМ віддано під рух полем — але в полях введення лишаємо системне меню */
document.addEventListener('contextmenu', e => {
  if (!/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) e.preventDefault();
});

canvas.addEventListener('pointerdown', onCanvasDown);
canvas.addEventListener('pointermove', e => {
  cursorWorld = toWorld(e.clientX, e.clientY);
  if (linkFrom) drawTemp(getNode(linkFrom), cursorWorld);
});
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  hideCtx();
  if (e.shiftKey) { view.x -= e.deltaY; applyView(); saveSoon(); return; }  // горизонтальна прокрутка
  const r = viewportEl.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, view.scale * Math.exp(-e.deltaY * 0.0016));
}, { passive: false });

canvas.addEventListener('dblclick', e => {
  if (e.target.closest('.node')) return;
  if (recentTouchTap()) return;                       // подвійний тап уже обробили самі
  const p = toWorld(e.clientX, e.clientY);
  openNodeEditor(null, p);
});

function onCanvasDown(e) {
  hideCtx(); closeTopMenus();
  if (pinch) return;                                  // йде зум двома пальцями
  const touch = e.pointerType === 'touch';
  const panning = e.button === 2 || e.button === 1 || (e.button === 0 && (tool === 'hand' || spaceDown));
  if (panning) { e.preventDefault(); startPan(e); return; }
  if (e.button !== 0) return;

  /* режим клік-стрілки: другий клік завершує зʼєднання.
     На тачі — тільки якщо це тап, а не спроба посунути поле. */
  if (linkFrom) {
    const finish = ev => {
      const under  = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = under && under.closest('.node');
      finishConnect(linkFrom, toWorld(ev.clientX, ev.clientY), target && target.dataset.id);
    };
    if (touch) { startPan(e, finish); return; }
    finish(e);
    return;
  }
  if (e.target.closest('.node')) return;  // клік по ачівці обробляє її хендлер

  if (tool === 'add') {
    if (touch) { startPan(e, ev => openNodeEditor(null, toWorld(ev.clientX, ev.clientY))); return; }
    openNodeEditor(null, toWorld(e.clientX, e.clientY));
    return;
  }
  if (tool === 'link') { toast('Тапни по ачівці, від якої тягнути стрілку'); return; }

  /* тач: палець по пустому полю рухає поле; тап знімає виділення,
     подвійний тап створює ачівку, довгий тап відкриває меню поля */
  if (touch) { startPan(e, onCanvasTap); armLongPress(e); return; }
  startMarquee(e);
}

/** Перериває поточне перетягування (потрібно, коли починається жест двома пальцями). */
function endActiveDrag() {
  const a = activeDrag; activeDrag = null;
  if (a) a.cancel();
}

/* --- рух полем (ПКМ / середня / рука / space / палець) --- */
function startPan(e, onTap) {
  endActiveDrag();
  const s = { cx: e.clientX, cy: e.clientY, vx: view.x, vy: view.y };
  let moved = false;
  canvas.classList.add('panning');
  const mv = ev => {
    if (Math.hypot(ev.clientX - s.cx, ev.clientY - s.cy) > 6) moved = true;
    view.x = s.vx + (ev.clientX - s.cx); view.y = s.vy + (ev.clientY - s.cy);
    applyView();
  };
  const done = tapEv => {
    canvas.classList.remove('panning');
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    activeDrag = null;
    saveSoon();
    if (tapEv && !moved && onTap) onTap(tapEv);
  };
  const up     = ev => done(ev);
  const cancel = () => done(null);
  activeDrag = { cancel };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

/* --- рамка виділення --- */
function startMarquee(e) {
  endActiveDrag();
  const box = $('#marquee');
  const r = viewportEl.getBoundingClientRect();
  const x0 = e.clientX - r.left, y0 = e.clientY - r.top;
  let moved = false;
  const mv = ev => {
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    if (!moved && Math.abs(x - x0) + Math.abs(y - y0) < 4) return;
    moved = true; box.hidden = false;
    box.style.left = Math.min(x0, x) + 'px';
    box.style.top  = Math.min(y0, y) + 'px';
    box.style.width  = Math.abs(x - x0) + 'px';
    box.style.height = Math.abs(y - y0) + 'px';
  };
  const up = ev => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
    activeDrag = null;
    box.hidden = true;
    if (!ev) return;                       // перервано жестом
    if (!moved) { clearSelection(); return; }
    const p1 = toWorld(Math.min(e.clientX, ev.clientX), Math.min(e.clientY, ev.clientY));
    const p2 = toWorld(Math.max(e.clientX, ev.clientX), Math.max(e.clientY, ev.clientY));
    selection = new Set(state.nodes
      .filter(n => n.x >= p1.x && n.x <= p2.x && n.y >= p1.y && n.y <= p2.y)
      .map(n => n.id));
    selEdge = null;
    syncSelection();
  };
  activeDrag = { cancel: () => up(null) };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
}

function clearSelection() { selection.clear(); selEdge = null; syncSelection(); }
function syncSelection() {
  for (const n of state.nodes) {
    const el = nodeEl(n.id);
    if (el) el.classList.toggle('sel', selection.has(n.id));
  }
  updateEdgePaths();
}

/* --- ачівки: перетягування, клік, ручки --- */
nodesEl.addEventListener('pointerdown', e => {
  const el = e.target.closest('.node'); if (!el) return;
  const n = getNode(el.dataset.id); if (!n) return;
  if (e.button !== 0) return;                          // ПКМ -> віддаємо панорамі
  if (pinch) return;                                   // йде зум двома пальцями
  if (linkFrom) return;                                // завершення зʼєднання ловить canvas
  e.stopPropagation();

  const handle = e.target.closest('.handle');
  if (handle) { startDragConnect(e, n); return; }
  if (tool === 'link') { beginLink(n.id); return; }     // інструмент ⤳: клік по ачівці стартує стрілку
  startNodeDrag(e, n, el);
});
nodesEl.addEventListener('dblclick', e => {
  if (TOUCH) return;            // на тачі перший тап уже відкрив меню ачівки
  const el = e.target.closest('.node');
  if (el) { e.stopPropagation(); openDetails(el.dataset.id); }
});

function startNodeDrag(e, n, el) {
  endActiveDrag();
  if (!selection.has(n.id)) { selection = new Set([n.id]); selEdge = null; syncSelection(); }
  const ids   = [...selection];
  const start = ids.map(id => { const m = getNode(id); return { id, x: m.x, y: m.y }; });
  const p0    = toWorld(e.clientX, e.clientY);
  const before = snapshot();
  let moved = false, raf = 0;

  const mv = ev => {
    const p = toWorld(ev.clientX, ev.clientY);
    const dx = p.x - p0.x, dy = p.y - p0.y;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3 / view.scale) return;
    moved = true;
    el.classList.add('dragging');
    for (const s of start) {
      const m = getNode(s.id); if (!m) continue;
      m.x = Math.round(s.x + dx); m.y = Math.round(s.y + dy);
      const mel = nodeEl(s.id);
      if (mel) { mel.style.left = m.x + 'px'; mel.style.top = m.y + 'px'; }
    }
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; updateEdgePaths(); });
  };
  const finish = allowMenu => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    activeDrag = null;
    el.classList.remove('dragging');
    if (moved) { past.push(before); future.length = 0; renderStats(); saveSoon(); }
    else if (allowMenu) showNodeMenu(n.id);             // клік/тап без руху -> меню опцій
  };
  const up     = () => finish(true);
  const cancel = () => finish(false);                   // перервано жестом зуму
  activeDrag = { cancel };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

/* ---------------- 6.5) ТАЧ / ЖЕСТИ (Android) ---------------- */
/* Пальцем: тягни — рух полем · два пальці — зум · тап — зняти виділення
   подвійний тап — нова ачівка · довгий тап — меню поля.            */

const TOUCH = matchMedia('(pointer: coarse)').matches;

/* --- подвійний тап по пустому полю --- */
let lastTap = 0, lastTapPt = { x: 0, y: 0 }, lastTouchTapAt = 0;
const recentTouchTap = () => Date.now() - lastTouchTapAt < 700;   // щоб dblclick не дублював

function onCanvasTap(ev) {
  if (ctxWasOpen) { ctxWasOpen = false; lastTap = 0; return; }   // тап лише закрив меню
  const now  = Date.now();
  const near = Math.hypot(ev.clientX - lastTapPt.x, ev.clientY - lastTapPt.y) < 40;
  if (now - lastTap < 330 && near) {
    lastTap = 0; lastTouchTapAt = now;
    openNodeEditor(null, toWorld(ev.clientX, ev.clientY));
    return;
  }
  lastTap = now; lastTapPt = { x: ev.clientX, y: ev.clientY };
  lastTouchTapAt = now;
  clearSelection();
}

/* --- довгий тап по полю -> меню --- */
function armLongPress(e) {
  const sx = e.clientX, sy = e.clientY;
  let timer = setTimeout(() => {
    timer = 0; off();
    if (pinch) return;
    endActiveDrag();
    lastTap = 0;
    try { navigator.vibrate && navigator.vibrate(12); } catch (err) { /* без відгуку — не біда */ }
    showCanvasMenu(sx, sy);
  }, 480);
  const mv = ev => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) off(); };
  function off() {
    if (timer) { clearTimeout(timer); timer = 0; }
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', off);
    window.removeEventListener('pointercancel', off);
  }
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', off);
  window.addEventListener('pointercancel', off);
}

function showCanvasMenu(cx, cy) {
  const p = toWorld(cx, cy);
  openCtx(cx, cy, `
    <div class="cm-head">Поле</div>
    <button data-a="add">✨ Нова ачівка тут</button>
    <button data-a="all">☑ Виділити все</button>
    <button data-a="fit">⤢ Показати все</button>
    <button data-a="reset">◎ Масштаб 100%</button>
  `, a => {
    if (a === 'add')   openNodeEditor(null, p);
    if (a === 'fit')   fitView();
    if (a === 'reset') resetView();
    if (a === 'all')   { selection = new Set(state.nodes.map(n => n.id)); selEdge = null; syncSelection(); }
  });
}

/* --- зум двома пальцями (щипок) + рух полем середньою точкою --- */
function pinchPoints(touches, r) {
  const a = touches[0], b = touches[1];
  return {
    x: (a.clientX + b.clientX) / 2 - r.left,
    y: (a.clientY + b.clientY) / 2 - r.top,
    d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
  };
}
canvas.addEventListener('touchstart', e => {
  if (e.touches.length !== 2) return;
  e.preventDefault();
  endActiveDrag(); hideCtx(); lastTap = 0;
  const m = pinchPoints(e.touches, viewportEl.getBoundingClientRect());
  pinch = { d0: m.d, wx: (m.x - view.x) / view.scale, wy: (m.y - view.y) / view.scale, s0: view.scale };
}, { passive: false });

canvas.addEventListener('touchmove', e => {
  if (!pinch || e.touches.length < 2) return;
  e.preventDefault();
  const m = pinchPoints(e.touches, viewportEl.getBoundingClientRect());
  const s = clamp(pinch.s0 * (m.d / pinch.d0), MIN_Z, MAX_Z);
  view.scale = s;
  view.x = m.x - pinch.wx * s;
  view.y = m.y - pinch.wy * s;
  applyView();
}, { passive: false });

const endPinch = e => {
  if (!pinch || e.touches.length >= 2) return;
  pinch = null; lastTap = 0; lastTouchTapAt = Date.now();
  saveSoon();
};
canvas.addEventListener('touchend', endPinch);
canvas.addEventListener('touchcancel', endPinch);

/* ---------------- 7) СТРІЛКИ ---------------- */
/** Перетягування від ручки «+». */
function startDragConnect(e, from) {
  hideCtx(); endActiveDrag();
  let dropped = false;
  const mv = ev => drawTemp(from, toWorld(ev.clientX, ev.clientY));
  const up = ev => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    activeDrag = null;
    clearTemp();
    if (dropped || !ev) return; dropped = true;
    const under  = document.elementFromPoint(ev.clientX, ev.clientY);
    const target = under && under.closest('.node');
    finishConnect(from.id, toWorld(ev.clientX, ev.clientY), target && target.dataset.id);
  };
  const cancel = () => up(null);
  activeDrag = { cancel };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  drawTemp(from, cursorWorld);
}

/** Режим «клік-стрілка» (інструмент ⤳ або пункт меню). */
function beginLink(id) {
  linkFrom = id;
  toast('Клікни, де поставити нову ачівку — або по існуючій, щоб зʼєднати. Esc — скасувати');
  drawTemp(getNode(id), cursorWorld);
}
function cancelLink() { linkFrom = null; clearTemp(); }

function finishConnect(fromId, point, targetId) {
  cancelLink();
  const from = getNode(fromId); if (!from) return;
  if (targetId && targetId !== fromId) { addEdge(fromId, targetId); return; }
  if (targetId === fromId) return;
  /* кинули в пусте місце -> нова ачівка тут + стрілка */
  openNodeEditor(null, point, newId => addEdge(fromId, newId), from);
}

function addEdge(from, to) {
  if (state.edges.some(e => e.from === from && e.to === to)) { toast('Такий звʼязок уже є'); return; }
  withHistory(() => state.edges.push({ id: uid(), from, to, label: '' }));
}

function drawTemp(from, p) {
  if (!from) return;
  clearTemp();
  const g = geom(from, { x: p.x, y: p.y });
  tempLayer.append(
    svgEl('path', { class: 'temp-edge', d: g.d, 'marker-end': 'url(#ah-sel)' }),
    svgEl('circle', { class: 'temp-dot', cx: p.x, cy: p.y, r: NODE_R })
  );
}
function clearTemp() { tempLayer.textContent = ''; }

/* ---------------- 8) МЕНЮ ---------------- */
function openCtx(clientX, clientY, html, onPick) {
  ctxmenu.innerHTML = html;
  ctxmenu.hidden = false;
  const r = ctxmenu.getBoundingClientRect();
  ctxmenu.style.left = clamp(clientX - r.width / 2, 8, innerWidth  - r.width  - 8) + 'px';
  ctxmenu.style.top  = clamp(clientY,               8, innerHeight - r.height - 8) + 'px';
  ctxmenu.onclick = ev => {
    const b = ev.target.closest('button[data-a]'); if (!b) return;
    hideCtx(); onPick(b.dataset.a);
  };
}
function hideCtx() { ctxmenu.hidden = true; }
let ctxWasOpen = false;   // тап, що просто закрив меню, не має знімати виділення
window.addEventListener('pointerdown', e => {
  if (e.target.closest('#ctxmenu')) return;
  ctxWasOpen = !ctxmenu.hidden;
  hideCtx();
}, true);

/** Головне меню ачівки: редагувати / детальніше / видалити. */
function showNodeMenu(id) {
  const n = getNode(id); if (!n) return;
  const p = toScreen(n.x, n.y + NODE_R + 46);
  openCtx(p.x, p.y, `
    <div class="cm-head">${esc(n.title)}</div>
    <button data-a="edit">✏️ Редагувати</button>
    <button data-a="details">🔍 Детальніше</button>
    <button data-a="link">⤳ Витягнути стрілку</button>
    <button data-a="status">${n.status === 'done' ? '🔓 Зняти «отримано»' : '🏅 Позначити отриманою'}</button>
    <button data-a="dup">⧉ Дублювати</button>
    <button data-a="del" class="danger">🗑 Видалити <span class="k">Del</span></button>
  `, a => {
    if (a === 'edit')    openNodeEditor(id);
    if (a === 'details') openDetails(id);
    if (a === 'link')    beginLink(id);
    if (a === 'dup')     duplicateNode(id);
    if (a === 'del')     deleteNodes([id]);
    if (a === 'status')  withHistory(() => { n.status = n.status === 'done' ? 'progress' : 'done'; });
  });
}

/** Меню стрілки. */
edgeLayer.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const g = e.target.closest('g[data-id]'); if (!g) return;
  e.stopPropagation();
  selection.clear(); selEdge = g.dataset.id; syncSelection();
  const ed = getEdge(selEdge); if (!ed) return;
  openCtx(e.clientX, e.clientY + 10, `
    <div class="cm-head">Звʼязок</div>
    <button data-a="label">🏷 Підпис стрілки</button>
    <button data-a="flip">⇄ Змінити напрямок</button>
    <button data-a="del" class="danger">🗑 Видалити звʼязок</button>
  `, a => {
    if (a === 'del')  withHistory(() => { state.edges = state.edges.filter(x => x.id !== ed.id); selEdge = null; });
    if (a === 'flip') withHistory(() => { const t = ed.from; ed.from = ed.to; ed.to = t; });
    if (a === 'label') {
      const v = prompt('Підпис стрілки (порожньо — прибрати):', ed.label || '');
      if (v !== null) withHistory(() => { ed.label = v.trim(); });
    }
  });
});

function deleteNodes(ids) {
  const set = new Set(ids);
  withHistory(() => {
    state.nodes = state.nodes.filter(n => !set.has(n.id));
    state.edges = state.edges.filter(e => !set.has(e.from) && !set.has(e.to));
    selection.clear();
  });
  toast(ids.length > 1 ? `Видалено ачівок: ${ids.length}` : 'Ачівку видалено');
}
function duplicateNode(id) {
  const n = getNode(id); if (!n) return;
  withHistory(() => {
    const c = normalizeNode({ ...n, id: uid(), x: n.x + 170, y: n.y + 60, title: n.title + ' (копія)' });
    c.milestones = n.milestones.map(m => ({ id: uid(), text: m.text, done: m.done }));
    state.nodes.push(c);
    selection = new Set([c.id]);
  });
}

/* ---------------- 9) МОДАЛКИ ---------------- */
function openModal({ title, body, footer, wide }) {
  modalRoot.innerHTML = `
    <div class="overlay">
      <div class="modal ${wide ? 'wide' : ''}">
        <div class="modal-h"><h3>${title}</h3><button class="x" data-close>✕</button></div>
        <div class="modal-b">${body}</div>
        <div class="modal-f">${footer}</div>
      </div>
    </div>`;
  const overlay = $('.overlay', modalRoot);
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) closeModal(); });
  $$('[data-close]', modalRoot).forEach(b => b.addEventListener('click', closeModal));
  return $('.modal', modalRoot);
}
function closeModal() { modalRoot.textContent = ''; }
const modalOpen = () => !!modalRoot.firstElementChild;

/* --- редактор / створення ачівки --- */
function openNodeEditor(id, pos, onCreated, fromNode) {
  const editing = !!id;
  if (!editing && !pos) {                      // фолбек: центр видимої області
    const r = viewportEl.getBoundingClientRect();
    pos = toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }
  const n = editing ? getNode(id) : {
    title: '', icon: pickIcon(), desc: '', milestones: [],
    category: fromNode ? fromNode.category : 'personal', status: 'locked',
  };
  if (editing && !n) return;

  const m = openModal({
    title: editing ? '✏️ Редагувати ачівку' : '✨ Нова ачівка',
    wide: true,
    body: `
      <div class="field">
        <label>Назва ачівки</label>
        <input type="text" id="fTitle" value="${esc(n.title)}" placeholder="Напр.: Запустити перший продукт" maxlength="80">
      </div>
      <div class="icon-line">
        <div class="icon-preview" id="fPrev">${esc(n.icon)}</div>
        <div style="flex:1">
          <div class="field" style="margin:0">
            <label>Емблема (емодзі)</label>
            <input type="text" id="fIcon" value="${esc(n.icon)}" maxlength="4">
          </div>
        </div>
      </div>
      <div class="icon-grid" id="fGrid">
        ${ICONS.map(i => `<button type="button" data-i="${i}" class="${i === n.icon ? 'on' : ''}">${i}</button>`).join('')}
      </div>
      <div class="row2" style="margin-top:14px">
        <div class="field">
          <label>Категорія</label>
          <select id="fCat">
            ${Object.entries(CATEGORIES).map(([k, v]) =>
              `<option value="${k}" ${k === n.category ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Статус</label>
          <div class="seg" id="fStat">
            ${Object.entries(STATUSES).map(([k, v]) =>
              `<button type="button" data-s="${k}" class="${k === n.status ? 'on' : ''}">${v}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="field">
        <label>Опис</label>
        <textarea id="fDesc" placeholder="Що саме означає ця ачівка, навіщо вона, як зрозуміти що вона досягнута…">${esc(n.desc)}</textarea>
      </div>
      <div class="field" style="margin-bottom:0">
        <label>Головні milestones</label>
        <div class="ms-list" id="fMs"></div>
        <button class="btn ghost" id="fMsAdd" style="margin-top:8px">+ Додати milestone</button>
      </div>`,
    footer: `
      ${editing ? '<button class="btn danger" id="fDel">Видалити</button>' : ''}
      <div style="flex:1"></div>
      <button class="btn" data-close>Скасувати</button>
      <button class="btn primary" id="fSave">${editing ? 'Зберегти' : 'Створити'}</button>`,
  });

  let status = n.status;
  const msWrap = $('#fMs', m);
  n.milestones.forEach(ms => addMsRow(msWrap, ms));

  $('#fIcon', m).addEventListener('input', ev => {
    $('#fPrev', m).textContent = ev.target.value || '⭐';
    $$('#fGrid button', m).forEach(b => b.classList.toggle('on', b.dataset.i === ev.target.value));
  });
  $('#fGrid', m).addEventListener('click', ev => {
    const b = ev.target.closest('button[data-i]'); if (!b) return;
    $('#fIcon', m).value = b.dataset.i;
    $('#fPrev', m).textContent = b.dataset.i;
    $$('#fGrid button', m).forEach(x => x.classList.toggle('on', x === b));
  });
  $('#fStat', m).addEventListener('click', ev => {
    const b = ev.target.closest('button[data-s]'); if (!b) return;
    status = b.dataset.s;
    $$('#fStat button', m).forEach(x => x.classList.toggle('on', x === b));
  });
  $('#fMsAdd', m).addEventListener('click', () => {
    addMsRow(msWrap, { id: uid(), text: '', done: false });
    msWrap.lastElementChild.querySelector('input[type=text]').focus();
  });
  if (editing) $('#fDel', m).addEventListener('click', () => { closeModal(); deleteNodes([id]); });

  const save = () => {
    const data = {
      title: $('#fTitle', m).value.trim() || 'Без назви',
      icon:  $('#fIcon', m).value.trim() || '⭐',
      category: $('#fCat', m).value,
      status,
      desc: $('#fDesc', m).value,
      milestones: $$('.ms-row', msWrap).map(r => ({
        id: r.dataset.id,
        text: r.querySelector('input[type=text]').value.trim(),
        done: r.querySelector('input[type=checkbox]').checked,
      })).filter(x => x.text),
    };
    closeModal();
    if (editing) {
      withHistory(() => Object.assign(getNode(id), data));
    } else {
      const created = withHistory(() => {
        const nn = normalizeNode({ ...data, id: uid(), x: Math.round(pos.x), y: Math.round(pos.y) });
        state.nodes.push(nn);
        selection = new Set([nn.id]);
        return nn.id;
      });
      if (onCreated) onCreated(created);
    }
  };
  $('#fSave', m).addEventListener('click', save);
  $('#fTitle', m).addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  $('#fTitle', m).focus();
}

function addMsRow(wrap, ms) {
  const row = document.createElement('div');
  row.className = 'ms-row' + (ms.done ? ' done' : '');
  row.dataset.id = ms.id || uid();
  row.innerHTML = `
    <input type="checkbox" ${ms.done ? 'checked' : ''} title="Виконано">
    <input type="text" value="${esc(ms.text)}" placeholder="Крок до ачівки…" maxlength="140">
    <button class="ms-del" title="Прибрати">✕</button>`;
  row.querySelector('.ms-del').addEventListener('click', () => row.remove());
  row.querySelector('input[type=checkbox]').addEventListener('change', e =>
    row.classList.toggle('done', e.target.checked));
  wrap.appendChild(row);
}

/* --- деталі --- */
function openDetails(id) {
  const n = getNode(id); if (!n) return;
  const cat = CATEGORIES[n.category] || CATEGORIES.other;

  const m = openModal({
    title: '🔍 Деталі ачівки',
    body: `
      <div class="d-head" style="--accent:${cat.color}">
        <div class="d-orb" style="--p:${progressPct(n)}"><div>${esc(n.icon)}</div></div>
        <div style="min-width:0">
          <h3 class="d-title">${esc(n.title)}</h3>
          <div class="tags">
            <span class="tag"><i class="f-dot" style="background:${cat.color}"></i>${cat.label}</span>
            <span class="tag ${n.status}" id="dStat">${n.status === 'done' ? '🏅 ' : ''}${STATUSES[n.status]}</span>
            <span class="tag">${n.milestones.length} milestones</span>
          </div>
        </div>
      </div>
      <div class="d-sec">
        <h4>Опис</h4>
        <div class="d-desc ${n.desc ? '' : 'empty'}">${n.desc ? esc(n.desc) : 'Опису ще немає — додай через «Редагувати».'}</div>
      </div>
      <div class="d-sec">
        <h4>Головні milestones <span class="pct" id="dPct"></span></h4>
        <div class="bar"><i id="dBar"></i></div>
        <div class="mile" id="dMile"></div>
      </div>`,
    footer: `
      <button class="btn ghost" id="dLink">⤳ Витягнути стрілку</button>
      <div style="flex:1"></div>
      <button class="btn" data-close>Закрити</button>
      <button class="btn primary" id="dEdit">✏️ Редагувати</button>`,
  });

  const mile = $('#dMile', m);
  const paint = () => {
    const t = n.milestones.length, d = n.milestones.filter(x => x.done).length;
    $('#dPct', m).textContent = t ? `${d}/${t} · ${Math.round(d / t * 100)}%` : '';
    $('#dBar', m).style.width = (t ? d / t * 100 : 0) + '%';
    $('.d-orb', m).style.setProperty('--p', progressPct(n));
    const st = $('#dStat', m);
    st.className = 'tag ' + n.status;
    st.textContent = (n.status === 'done' ? '🏅 ' : '') + STATUSES[n.status];
  };

  if (!n.milestones.length) {
    mile.innerHTML = `<div class="empty-note">Milestones ще не додані. Відкрий «Редагувати», щоб розписати кроки.</div>`;
  } else {
    n.milestones.forEach(ms => {
      const lab = document.createElement('label');
      lab.className = ms.done ? 'done' : '';
      lab.innerHTML = `<input type="checkbox" ${ms.done ? 'checked' : ''}><span>${esc(ms.text)}</span>`;
      lab.querySelector('input').addEventListener('change', ev => {
        withHistory(() => {
          ms.done = ev.target.checked;
          /* статус підтягується автоматично, якщо є milestones */
          const t = n.milestones.length, d = n.milestones.filter(x => x.done).length;
          n.status = d === t ? 'done' : d ? 'progress' : 'locked';
        });
        lab.classList.toggle('done', ms.done);
        paint();
      });
      mile.appendChild(lab);
    });
  }
  paint();

  $('#dEdit', m).addEventListener('click', () => { closeModal(); openNodeEditor(id); });
  $('#dLink', m).addEventListener('click', () => { closeModal(); beginLink(id); });
}

/* --- довідка --- */
function openHelp() {
  if (TOUCH) return openHelpTouch();
  openModal({
    title: '⌨️ Керування',
    body: `<div class="help-grid">
      <kbd>ПКМ</kbd><span>рух полем (затисни й тягни)</span>
      <kbd>H</kbd><span>інструмент «Рука» — рух ЛКМ</span>
      <kbd>Space</kbd><span>тимчасово рука</span>
      <kbd>Колесо</kbd><span>зум до курсора · <kbd>Shift</kbd>+колесо — вбік</span>
      <kbd>V</kbd><span>вибір і переміщення</span>
      <kbd>A</kbd><span>нова ачівка (клік по полю)</span>
      <kbd>C</kbd><span>стрілка від ачівки</span>
      <kbd>2× клік</kbd><span>по полю — нова ачівка · по ачівці — деталі</span>
      <kbd>Клік</kbd><span>по ачівці — меню (редагувати / детальніше / видалити)</span>
      <kbd>Тягни +</kbd><span>з кружечка — стрілка; відпусти в пустоті → нова ачівка</span>
      <kbd>Del</kbd><span>видалити виділене</span>
      <kbd>Ctrl+Z</kbd><span>відмінити · <kbd>Ctrl+Shift+Z</kbd> повторити</span>
      <kbd>Ctrl+A</kbd><span>виділити все</span>
      <kbd>F</kbd><span>показати всю дошку · <kbd>0</kbd> — 100%</span>
      <kbd>Esc</kbd><span>скасувати дію / закрити</span>
    </div>`,
    footer: `<div style="flex:1"></div><button class="btn primary" data-close>Зрозуміло</button>`,
  });
}

/** Та сама довідка, але жестами — для телефона/планшета. */
function openHelpTouch() {
  openModal({
    title: '👆 Керування жестами',
    body: `<div class="help-grid">
      <kbd>Тягни</kbd><span>рух по дошці</span>
      <kbd>Два пальці</kbd><span>зум (щипок)</span>
      <kbd>Тап по ачівці</kbd><span>меню: редагувати · детальніше · стрілка · видалити</span>
      <kbd>Тягни ачівку</kbd><span>перемістити (кілька — якщо виділені)</span>
      <kbd>Подвійний тап</kbd><span>по пустому полю — нова ачівка</span>
      <kbd>Довгий тап</kbd><span>по полю — меню: нова ачівка, виділити все, масштаб</span>
      <kbd>Тап по стрілці</kbd><span>підпис · напрямок · видалити</span>
      <kbd>Тягни +</kbd><span>кружечок на виділеній ачівці — стрілка; відпусти в пустоті → нова ачівка</span>
      <kbd>Нижня панель</kbd><span>інструменти, «показати все», відмінити/повторити</span>
      <kbd>🔎</kbd><span>пошук і фільтр · <kbd>⋯</kbd> — експорт, імпорт, тема</span>
    </div>`,
    footer: `<div style="flex:1"></div><button class="btn primary" data-close>Зрозуміло</button>`,
  });
}

/* ---------------- 10) ПАНЕЛІ, АДАПТИВ, КЛАВІАТУРА, СТАРТ ---------------- */

/* --- адаптив: на вузькому екрані ліва панель стає нижньою, частина кнопок
       переїжджає у меню «⋯», а чіп прогресу та undo/redo — на видні місця --- */
const MOBILE_MQ = matchMedia('(max-width:820px)');
const topbarEl  = $('#topbar');
const homes     = new Map();                    // елемент -> де він живе на десктопі

function rememberHome(el) { homes.set(el, { parent: el.parentNode, next: el.nextSibling }); }
function goHome(el) { const h = homes.get(el); if (h) h.parent.insertBefore(el, h.next); }
['#progressChip', '#btnUndo', '#btnRedo'].forEach(s => rememberHome($(s)));

function closeTopMenus() { topbarEl.classList.remove('menu-open'); }

function applyResponsive() {
  const m = MOBILE_MQ.matches;
  document.body.classList.toggle('is-mobile', m);
  if (m) {
    $('#tbMobile').prepend($('#progressChip'));           // прогрес лишається на виду
    $('#leftbar').append($('#btnUndo'), $('#btnRedo'));   // undo/redo — у нижній тулбар
  } else {
    goHome($('#progressChip')); goHome($('#btnUndo')); goHome($('#btnRedo'));
  }
  closeTopMenus();
  topbarEl.classList.remove('search-open');
}
MOBILE_MQ.addEventListener('change', applyResponsive);

$('#btnSearchM').addEventListener('click', () => {
  closeTopMenus();
  const open = topbarEl.classList.toggle('search-open');
  if (open) $('#search').focus();
  else {
    $('#search').blur();
    $('#filterPop').hidden = true; $('#btnFilter').classList.remove('on');
  }
});
$('#btnMore').addEventListener('click', () => {
  topbarEl.classList.remove('search-open');
  topbarEl.classList.toggle('menu-open');
});
/* тап по пункту меню «⋯» закриває його */
$('.tb-right').addEventListener('click', e => { if (e.target.closest('.tb-btn')) closeTopMenus(); });
window.addEventListener('pointerdown', e => { if (!e.target.closest('#topbar')) closeTopMenus(); }, true);

$('#boardName').addEventListener('input', e => { state.name = e.target.value; saveSoon(); });
$('#search').addEventListener('input', e => { filter.q = e.target.value; applyFilter(); });
$('#searchClear').addEventListener('click', () => { $('#search').value = ''; filter.q = ''; applyFilter(); });
$('#btnUndo').addEventListener('click', undo);
$('#btnRedo').addEventListener('click', redo);
$('#btnHelp').addEventListener('click', openHelp);
$('#zoomHud').addEventListener('click', e => {
  const z = e.target.dataset.z;
  if (z === 'in')  zoomCenter(1.2);
  if (z === 'out') zoomCenter(1 / 1.2);
  if (z === 'reset') resetView();
});

$('#btnTheme').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  localStorage.setItem(THEME_KEY, t);
});

$('#btnClear').addEventListener('click', () => {
  if (!confirm('Очистити дошку? Всі ачівки та звʼязки буде видалено (можна відмінити через Ctrl+Z).')) return;
  withHistory(() => { state.nodes = []; state.edges = []; selection.clear(); selEdge = null; });
});

$('#btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.name || 'achievement-board').replace(/[^\wа-яіїєґА-ЯІЇЄҐ\- ]+/gi, '') + '.json';
  a.click(); URL.revokeObjectURL(a.href);
  toast('Дошку експортовано у JSON');
});
$('#btnImport').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const d = JSON.parse(rd.result);
      withHistory(() => {
        state.name  = d.name || state.name;
        state.nodes = (d.nodes || []).map(normalizeNode);
        state.edges = (d.edges || []).filter(x => x && x.from && x.to);
      });
      $('#boardName').value = state.name;
      fitView(); toast('Дошку імпортовано');
    } catch (err) { toast('Не вдалося прочитати файл'); }
  };
  rd.readAsText(f);
  e.target.value = '';
});

/* фільтр за категоріями та статусами */
$('#btnFilter').addEventListener('click', () => {
  const pop = $('#filterPop');
  if (!pop.hidden) { pop.hidden = true; $('#btnFilter').classList.remove('on'); return; }
  const count = fn => state.nodes.filter(fn).length;
  pop.innerHTML = `
    <h4>Категорії</h4>
    ${Object.entries(CATEGORIES).map(([k, v]) => `
      <label class="f-row"><input type="checkbox" data-c="${k}" ${filter.cats.has(k) ? 'checked' : ''}>
      <i class="f-dot" style="background:${v.color}"></i>${v.label}
      <span class="f-count">${count(n => n.category === k)}</span></label>`).join('')}
    <h4 style="margin-top:12px">Статус</h4>
    ${Object.entries(STATUSES).map(([k, v]) => `
      <label class="f-row"><input type="checkbox" data-s="${k}" ${filter.stats.has(k) ? 'checked' : ''}>
      ${v}<span class="f-count">${count(n => n.status === k)}</span></label>`).join('')}
    <button class="btn ghost" id="fAll" style="width:100%;margin-top:10px">Показати все</button>`;
  pop.hidden = false;
  $('#btnFilter').classList.add('on');
  pop.onchange = e => {
    const t = e.target;
    const set = t.dataset.c ? filter.cats : filter.stats;
    const key = t.dataset.c || t.dataset.s;
    t.checked ? set.add(key) : set.delete(key);
    applyFilter();
  };
  $('#fAll').addEventListener('click', () => {
    filter.cats = new Set(Object.keys(CATEGORIES));
    filter.stats = new Set(Object.keys(STATUSES));
    $$('input[type=checkbox]', pop).forEach(c => c.checked = true);
    applyFilter();
  });
});

/* клавіатура */
window.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.key === 'Escape') {
    if (modalOpen()) return closeModal();
    if (!ctxmenu.hidden) return hideCtx();
    if (topbarEl.classList.contains('menu-open')) return closeTopMenus();
    if (linkFrom) return cancelLink();
    if (!$('#filterPop').hidden) { $('#filterPop').hidden = true; $('#btnFilter').classList.remove('on'); return; }
    if (typing) return e.target.blur();
    return clearSelection();
  }
  if (typing || modalOpen()) return;

  const k = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if (k === 'y') { e.preventDefault(); redo(); }
    if (k === 's') { e.preventDefault(); saveSoon(); toast('Збережено локально'); }
    if (k === 'a') { e.preventDefault(); selection = new Set(state.nodes.map(n => n.id)); selEdge = null; syncSelection(); }
    return;
  }
  if (e.code === 'Space' && !spaceDown) { spaceDown = true; canvas.classList.add('t-hand'); }
  if (k === 'v') setTool('select');
  if (k === 'h') setTool('hand');
  if (k === 'a') setTool('add');
  if (k === 'c') setTool('link');
  if (k === 'f') fitView();
  if (k === '0') resetView();
  if (k === '=' || k === '+') zoomCenter(1.2);
  if (k === '-') zoomCenter(1 / 1.2);
  if (k === '?' || k === '/') openHelp();
  if (k === 'delete' || k === 'backspace') {
    if (selEdge) { const id = selEdge; withHistory(() => { state.edges = state.edges.filter(x => x.id !== id); selEdge = null; }); }
    else if (selection.size) deleteNodes([...selection]);
  }
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space') { spaceDown = false; canvas.className = 't-' + tool; }
});

/* ---------------- утиліти ---------------- */
function uid() { return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3); }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}
function pickIcon() { return ICONS[Math.floor(Math.random() * 12)]; }

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------------- демо-дошка ---------------- */
function seed() {
  const N = (x, y, title, icon, category, status, desc, ms) => normalizeNode({
    id: uid(), x, y, title, icon, category, status, desc,
    milestones: (ms || []).map((t, i) => ({ id: uid(), text: t, done: status === 'done' || (status === 'progress' && i === 0) })),
  });
  const a = N(0,    0,   'Точка старту',        '🧭', 'other',    'done',
              'Момент, з якого починається роадмеп. Далі — дві гілки: особисте і робоче.', ['Визначити напрямки', 'Створити дошку']);
  const b = N(-320, 220, 'Спорт: 100 тренувань','💪', 'health',   'progress',
              'Стабільна фізична форма — база для всього іншого.', ['30 тренувань', '60 тренувань', '100 тренувань']);
  const c = N(0,    220, 'Прочитати 12 книг',   '📚', 'learning', 'progress',
              'Одна книга на місяць, з короткими конспектами.', ['Книга №1', 'Книга №6', 'Книга №12']);
  const d = N(320,  220, 'Перший реліз продукту','🚀','work',     'locked',
              'Довести власний проєкт до живих користувачів.', ['MVP-прототип', 'Перші 10 користувачів', 'Публічний реліз']);
  const e = N(320,  460, 'Роль тімліда',        '👔', 'work',     'locked',
              'Вирости з виконавця у людину, що веде команду.', ['Менторити джуна', 'Вести спринт', 'Офіційне призначення']);
  const f = N(-160, 460, 'Фінансова подушка',   '💰', 'finance',  'locked',
              'Резерв на 6 місяців життя без доходу.', ['1 місяць', '3 місяці', '6 місяців']);
  state.nodes = [a, b, c, d, e, f];
  state.edges = [
    { id: uid(), from: a.id, to: b.id, label: '' },
    { id: uid(), from: a.id, to: c.id, label: '' },
    { id: uid(), from: a.id, to: d.id, label: '' },
    { id: uid(), from: d.id, to: e.id, label: 'відкриває' },
    { id: uid(), from: c.id, to: d.id, label: '' },
    { id: uid(), from: b.id, to: f.id, label: '' },
  ];
}

/* ---------------- старт ---------------- */
document.documentElement.dataset.theme = localStorage.getItem(THEME_KEY) || 'dark';
const fresh = !load();
if (fresh) { seed(); saveSoon(); }
$('#boardName').value = state.name;
applyResponsive();
setTool('select');
applyView();
render();
if (fresh) fitView();      // на телефоні дошка інакше починається за краєм екрана
initRemote();               // якщо firebase-config.js заповнений — підʼєднає спільну дошку
/* адресний рядок Android змінює висоту вьюпорта — перераховуємо трансформ */
window.addEventListener('resize', applyView);
window.addEventListener('orientationchange', () => setTimeout(applyView, 250));
if (!localStorage.getItem('ab.seenHelp')) { localStorage.setItem('ab.seenHelp', '1'); setTimeout(openHelp, 400); }
