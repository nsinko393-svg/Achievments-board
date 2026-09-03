/* =========================================================
   Achievement Board — логіка (v3, дерево цілей)

   МОДЕЛЬ:
   · Стрілка A → B означає «A відкриває B», тобто A — блокер для B.
   · Фінальні цілі (з яких нічого не виходить) стоять ВНИЗУ,
     кроки до них — вище. Читається знизу вгору: ось ціль, ось що треба.
   · Ціль не можна закрити, поки не закриті всі її блокери.
     Стан рахується автоматично: locked / open / ready / done.

   Секції:
   0) конфіг            1) стан+сховище     1.5) спільна дошка (Firebase)
   2) DOM               3) граф і стани     4) авто-розкладка дерева
   5) рендер            6) вʼюпорт          7) інструменти
   8) події поля/тач    9) звʼязки          10) меню
   11) модалки          12) панелі/адаптив/клавіатура/старт
   ========================================================= */
'use strict';

/* ---------------- 0) КОНФІГ ---------------- */
const STORE_KEY  = 'ab.board.v3';
const LEGACY_KEY = 'ab.board.v2';     // дошка попередньої версії — мігрується один раз
const THEME_KEY  = 'ab.theme';
const MIN_Z = 0.15, MAX_Z = 2.6;

/* розміри за роллю у дереві: фінальна ціль більша за проміжний крок */
const SIZE  = { goal: 104, mid: 84, step: 68 };
const WIDTH = { goal: 170, mid: 150, step: 132 };
const ROW_GAP = 200;   // відстань між рядами
const COL_GAP = 30;    // мінімальний зазор між сусідами в ряду

/* Категорії — це тег і фільтр. Колір кружечка за замовчуванням береться
   від гілки (див. colorMode), категорія показується крапкою біля назви. */
const CATEGORIES = {
  personal: { label: 'Особисте',  color: '#7c9cff' },
  work:     { label: 'Робоче',    color: '#ffb545' },
  learning: { label: 'Навчання',  color: '#c084fc' },
  health:   { label: 'Здоровʼя',  color: '#4ade80' },
  finance:  { label: 'Фінанси',   color: '#38d9c9' },
  other:    { label: 'Інше',      color: '#94a3b8' },
};

/* Стани рахуються автоматично з графа — вручну задається лише «отримано». */
const STATES = {
  locked: 'Заблоковано',
  open:   'Доступно',
  ready:  'Готово до закриття',
  done:   'Отримано',
};

/* Кольори гілок: кожна фінальна ціль зі своїм відтінком. */
const BRANCH_HUES = ['#7c9cff','#ffb545','#c084fc','#4ade80','#38d9c9','#fb7185','#facc15','#60a5fa'];

/* Емблеми, згруповані — у пікері є вкладки й пошук. */
const ICON_GROUPS = {
  'Нагороди': ['🏆','🥇','🥈','🥉','🎖','🏅','👑','💎','⭐','🌟','✨','🔥','⚡','🎯','🚩','🏁','🎗','🔱'],
  'Розвиток': ['🧠','📚','🎓','📖','✍️','📝','🔬','🧪','🧩','💡','🗂','📊','📈','🔎','🧮','🗒','🎼','🗣'],
  'Робота':   ['💻','⌨️','🖥','🛠','🔨','⚙️','🧰','📦','🚀','🏗','🧱','📁','💼','👔','🤝','🧑‍💻','📐','🗜'],
  'Гроші':    ['💰','💵','💳','🏦','🪙','💹','📉','🧾','🛒','🏠','🚗','✈️','🎁','📆','🔑','🏝','⛵','🧿'],
  'Здоровʼя': ['💪','🏃','🧘','🥋','🚴','🏊','🏋️','⛹️','🍎','🥗','💧','😴','❤️','🫀','🦷','🧴','🩺','🌿'],
  'Життя':    ['🌱','🌍','🏔','🗺','🧭','⛺','🎸','🎨','🎬','🎤','📷','🐶','🐱','☕','🍳','🎮','🎲','🪴'],
  'Символи':  ['✅','🔒','🔓','⏳','⏱','🕒','♻️','🔁','➕','❗','❓','🛡','⚔️','🏹','🧗','🪜','🧲','🔗'],
};
const ICONS = Object.values(ICON_GROUPS).flat();

/* ---------------- 1) СТАН + СХОВИЩЕ ---------------- */
/* ВАЖЛИВО: state ніколи не перезаписується цілком — тільки його поля,
   бо на state.view тримається окреме посилання. */
let state = {
  name: 'Мій роадмеп',
  nodes: [], edges: [],
  view: { x: 0, y: 0, scale: 1 },
  auto: true,             // авто-розкладка дерева
  colorMode: 'branch',    // 'branch' | 'category'
};
const view = state.view;

let tool        = 'select';
let selection   = new Set();
let selEdge     = null;
let spaceDown   = false;
let linkFrom    = null;
let linkDir     = 'up';      // 'up' — новий вузол буде блокером, 'down' — навпаки
let cursorWorld = { x: 0, y: 0 };
let activeDrag  = null;
let pinch       = null;
let focusMode   = false;
const filter = {
  q: '',
  cats:  new Set(Object.keys(CATEGORIES)),
  stats: new Set(Object.keys(STATES)),
};

const past = [], future = [];
const snapshot = () => JSON.stringify({ nodes: state.nodes, edges: state.edges });
function restore(json) {
  const d = JSON.parse(json);
  state.nodes = d.nodes; state.edges = d.edges;
  selection.clear(); selEdge = null;
  invalidate(); render();
}
/** Будь-яка зміна даних — через це: undo/redo + авто-розкладка + автозбереження. */
function withHistory(fn) {
  const before = snapshot();
  const r = fn();
  invalidate();
  if (state.auto) tidy();
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

let migrated = false;          // дошку підняли зі старого формату v2
function load() {
  const cur = localStorage.getItem(STORE_KEY);
  const raw = cur || localStorage.getItem(LEGACY_KEY);
  if (!raw) return false;
  try {
    adopt(JSON.parse(raw));
    migrated = !cur;           // стару дошку не чіпаємо — вона лишається як бекап
    return true;
  } catch (e) { return false; }
}
/** Приймає дошку будь-якої версії (v2 зі status → v3 з done). */
function adopt(d) {
  state.name  = d.name || 'Мій роадмеп';
  state.nodes = (d.nodes || []).map(normalizeNode);
  const ids = new Set(state.nodes.map(n => n.id));
  state.edges = (d.edges || [])
    .filter(e => e && e.from && e.to && e.from !== e.to && ids.has(e.from) && ids.has(e.to))
    .map(e => ({ id: e.id || uid(), from: e.from, to: e.to, label: e.label || '' }));
  if (d.view) Object.assign(view, d.view);
  if (typeof d.auto === 'boolean') state.auto = d.auto;
  if (d.colorMode) state.colorMode = d.colorMode;
  invalidate();
}
function normalizeNode(n) {
  return {
    id: n.id || uid(),
    x: +n.x || 0, y: +n.y || 0,
    title: n.title || 'Без назви',
    icon: n.icon || '⭐',
    category: CATEGORIES[n.category] ? n.category : 'other',
    /* v2 зберігав тристатусний status; тепер вручну задається лише «отримано» */
    done: typeof n.done === 'boolean' ? n.done : n.status === 'done',
    desc: n.desc || '',
    milestones: (n.milestones || []).map(m => ({ id: m.id || uid(), text: m.text || '', done: !!m.done })),
  };
}

/* ---------------- 1.5) СПІЛЬНА ДОШКА (Firebase) ----------------
   Синхронізуються лише name/nodes/edges. Панорама, зум, режим розкладки
   і кольорова схема — особисті для кожного пристрою. */
const FIREBASE_DOC = { col: 'boards', id: 'shared' };
let remote = null, connOk = null, lastRemoteJSON = null;
/* Доки не прочитали спільну дошку — нічого в неї не пишемо.
   Інакше новий відвідувач із порожнім localStorage встиг би
   відправити демо-дошку поверх справжньої, якщо мережа відповідає
   повільніше, ніж спрацьовує автозбереження. */
let remoteReady = false;

/** У спільний документ додаємо ще й похідний status — щоб стара версія
    застосунку на іншому пристрої теж могла прочитати дошку. */
function sharedJSON() {
  const g = graph();
  return JSON.stringify({
    name: state.name,
    nodes: state.nodes.map(n => ({ ...n, status: g.st.get(n.id) === 'done' ? 'done' : g.locked.get(n.id) ? 'locked' : 'progress' })),
    edges: state.edges,
  });
}
function paintSaveState() {
  $('#saveState').textContent = !remote ? 'збережено'
    : connOk === true ? 'синхронізовано' : connOk === false ? 'офлайн (локально)' : 'зʼєднання…';
}
function pushRemote() {
  if (!remote || !remoteReady) return;
  const json = sharedJSON();
  if (json === lastRemoteJSON) return;
  lastRemoteJSON = json;
  remote.set(JSON.parse(json)).catch(() => { connOk = false; paintSaveState(); });
}
function initRemote() {
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || cfg.apiKey === 'ВСТАВ_СЮДИ' || !window.firebase) return;
  try {
    firebase.initializeApp(cfg);
    remote = firebase.firestore().collection(FIREBASE_DOC.col).doc(FIREBASE_DOC.id);
  } catch (e) { remote = null; return; }

  let announced = false;
  remote.onSnapshot(snap => {
    connOk = true; paintSaveState();
    if (!announced) { announced = true; toast('Підключено до спільної дошки'); }
    const d = snap.data();
    remoteReady = true;                        // дошку прочитали — писати вже безпечно
    if (!d) { pushRemote(); return; }          // документа ще нема — створюємо з поточного стану
    const incoming = JSON.stringify({ name: d.name, nodes: d.nodes || [], edges: d.edges || [] });
    if (incoming === lastRemoteJSON) return;
    lastRemoteJSON = incoming;
    adopt({ name: d.name, nodes: d.nodes, edges: d.edges });
    selection.clear(); selEdge = null;
    $('#boardName').value = state.name;
    if (state.auto) tidy();
    render();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
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
const laneLayer  = $('#laneLayer');
const tempLayer  = $('#tempLayer');
const ctxmenu    = $('#ctxmenu');
const modalRoot  = $('#modalRoot');
const tplNode    = $('#tplNode');

const getNode = id => state.nodes.find(n => n.id === id);
const getEdge = id => state.edges.find(e => e.id === id);

/* ---------------- 3) ГРАФ І СТАНИ ----------------
   Один прохід рахує все похідне: шари, ролі, блокери, стани, гілки.
   Кеш скидається через invalidate() при кожній зміні даних. */
let G = null;
const invalidate = () => { G = null; };

function graph() {
  if (G) return G;

  const out = new Map(), inn = new Map();
  for (const n of state.nodes) { out.set(n.id, []); inn.set(n.id, []); }
  for (const e of state.edges) {
    if (!out.has(e.from) || !inn.has(e.to) || e.from === e.to) continue;
    out.get(e.from).push(e.to);
    inn.get(e.to).push(e.from);
  }

  /* шар 0 — фінальні цілі (внизу); що вище шар, то раніший крок */
  const layer = new Map(), mark = new Map();
  const depth = id => {
    const m = mark.get(id);
    if (m === 2) return layer.get(id);
    if (m === 1) return 0;                 // натрапили на цикл — обриваємо
    mark.set(id, 1);
    let v = 0;
    for (const t of out.get(id)) v = Math.max(v, depth(t) + 1);
    mark.set(id, 2); layer.set(id, v);
    return v;
  };
  for (const n of state.nodes) depth(n.id);

  /* стани: рахуємо від верхніх шарів (блокери) до нижніх (цілі) */
  const order  = [...state.nodes].sort((a, b) => layer.get(b.id) - layer.get(a.id));
  const done   = new Map(), locked = new Map(), left = new Map(), st = new Map();
  for (const n of order) {
    const pre  = inn.get(n.id);
    const miss = pre.filter(p => !done.get(p)).length;
    const t    = n.milestones.length;
    const raw  = n.done || (t > 0 && n.milestones.every(m => m.done));
    left.set(n.id, miss);
    locked.set(n.id, miss > 0);
    done.set(n.id, raw && miss === 0);
    st.set(n.id, miss > 0 ? (raw ? 'ready' : 'locked') : raw ? 'done' : 'open');
  }

  /* роль у дереві задає розмір кружечка */
  const role = new Map();
  for (const n of state.nodes) {
    role.set(n.id, out.get(n.id).length === 0 ? 'goal' : inn.get(n.id).length === 0 ? 'step' : 'mid');
  }

  /* гілка = фінальна ціль, до якої веде перший вихідний звʼязок */
  const sink = new Map();
  const findSink = id => {
    if (sink.has(id)) return sink.get(id);
    sink.set(id, id);                        // захист від циклу
    const o = out.get(id);
    const s = o.length ? findSink(o[0]) : id;
    sink.set(id, s);
    return s;
  };
  const branch = new Map(), sinkIdx = new Map();
  for (const n of state.nodes) {
    const s = findSink(n.id);
    if (!sinkIdx.has(s)) sinkIdx.set(s, sinkIdx.size);
    branch.set(n.id, sinkIdx.get(s));
  }

  G = { out, inn, layer, done, locked, left, st, role, branch, sinkIdx };
  return G;
}

const progressPct = (n, g) => {
  if (g.st.get(n.id) === 'done') return 100;
  const t = n.milestones.length;
  if (!t) return 0;
  return Math.round(n.milestones.filter(m => m.done).length / t * 100);
};
const accentOf = (n, g) =>
  state.colorMode === 'category'
    ? (CATEGORIES[n.category] || CATEGORIES.other).color
    : BRANCH_HUES[(g.branch.get(n.id) || 0) % BRANCH_HUES.length];

/** Чи створить звʼязок from→to цикл (to вже веде до from). */
function wouldCycle(from, to) {
  const g = graph();
  const seen = new Set([to]);
  const stack = [to];
  while (stack.length) {
    const id = stack.pop();
    if (id === from) return true;
    for (const t of g.out.get(id) || []) if (!seen.has(t)) { seen.add(t); stack.push(t); }
  }
  return false;
}
const plural = (n, one, few, many) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;

/* ---------------- 4) АВТО-РОЗКЛАДКА ДЕРЕВА ----------------
   Пошарова розкладка (спрощений Sugiyama):
   1) вузли розкладаються по шарах (шар 0 — фінальні цілі, внизу);
   2) кілька барицентричних проходів зменшують перетини стрілок;
   3) кілька проходів «притягнути до середнього сусідів + розсунути»
      дають компактні координати без накладань. */
function tidy() {
  if (!state.nodes.length) return;
  const g = graph();

  const rows = new Map();
  for (const n of state.nodes) {
    const l = g.layer.get(n.id) || 0;
    if (!rows.has(l)) rows.set(l, []);
    rows.get(l).push(n);
  }
  const layers = [...rows.keys()].sort((a, b) => a - b);
  for (const l of layers) rows.get(l).sort((a, b) => (a.x || 0) - (b.x || 0) || a.id.localeCompare(b.id));

  const idx = new Map();
  const reindex = () => { for (const l of layers) rows.get(l).forEach((n, i) => idx.set(n.id, i)); };
  reindex();

  /* барицентричні проходи */
  const bary = (n, nb) => {
    const xs = nb.map(id => idx.get(id)).filter(v => v != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : idx.get(n.id);
  };
  for (let it = 0; it < 4; it++) {
    const down = it % 2 === 0;
    const seq  = down ? layers : [...layers].reverse();
    for (const l of seq) {
      const row = rows.get(l);
      const key = new Map(row.map(n => [n.id, bary(n, down ? g.out.get(n.id) : g.inn.get(n.id))]));
      row.sort((a, b) => key.get(a.id) - key.get(b.id));
      reindex();
    }
  }

  /* координати */
  const wOf = n => WIDTH[g.role.get(n.id)];
  const pos = new Map();
  for (const l of layers) {
    let x = 0;
    for (const n of rows.get(l)) { pos.set(n.id, x + wOf(n) / 2); x += wOf(n) + COL_GAP; }
  }
  for (let it = 0; it < 8; it++) {
    const down = it % 2 === 0;
    const seq  = down ? layers : [...layers].reverse();
    for (const l of seq) {
      const row = rows.get(l);
      const desired = row.map(n => {
        const nb = (down ? g.out.get(n.id) : g.inn.get(n.id)).map(id => pos.get(id)).filter(v => v != null);
        return nb.length ? nb.reduce((a, b) => a + b, 0) / nb.length : pos.get(n.id);
      });
      const xs = resolveRow(row.map(wOf), desired);
      row.forEach((n, i) => pos.set(n.id, xs[i]));
    }
  }

  /* застосувати + вирівняти дошку по центру координат */
  const all = [...pos.values()];
  const shift = all.length ? (Math.min(...all) + Math.max(...all)) / 2 : 0;
  for (const n of state.nodes) {
    n.x = Math.round(pos.get(n.id) - shift);
    n.y = Math.round(-(g.layer.get(n.id) || 0) * ROW_GAP);
  }
}

/** Розсунути ряд так, щоб зберегти порядок і мінімальні зазори,
    залишившись максимально близько до бажаних позицій. */
function resolveRow(widths, desired) {
  const n = widths.length;
  if (!n) return [];
  const x = desired.slice();
  for (let i = 1; i < n; i++) {
    const min = x[i - 1] + widths[i - 1] / 2 + COL_GAP + widths[i] / 2;
    if (x[i] < min) x[i] = min;
  }
  for (let i = n - 2; i >= 0; i--) {
    const max = x[i + 1] - widths[i + 1] / 2 - COL_GAP - widths[i] / 2;
    if (x[i] > max) x[i] = max;
  }
  const avgD = desired.reduce((a, b) => a + b, 0) / n;
  const avgX = x.reduce((a, b) => a + b, 0) / n;
  const d = avgD - avgX;
  return x.map(v => v + d);
}

/* ---------------- 5) РЕНДЕР ----------------
   Інкрементний: елементи створюються один раз і далі лише оновлюються.
   Позиція — виключно transform (жодних left/top), тому пан і зум не
   викликають перерахунку розкладки сторінки. */
const nodeEls = new Map();
const edgeEls = new Map();

function render() { renderNodes(); renderEdges(); renderLanes(); renderStats(); }

function renderNodes() {
  const g = graph();
  const seen = new Set();
  for (const n of state.nodes) {
    seen.add(n.id);
    let el = nodeEls.get(n.id);
    if (!el) {
      el = tplNode.content.firstElementChild.cloneNode(true);
      el.dataset.id = n.id;
      el.classList.add('anim');
      nodesEl.appendChild(el);
      nodeEls.set(n.id, el);
    }
    paintNode(el, n, g);
  }
  for (const [id, el] of nodeEls) if (!seen.has(id)) { el.remove(); nodeEls.delete(id); }
  updateVisibility();
}

function paintNode(el, n, g) {
  const role = g.role.get(n.id), st = g.st.get(n.id);
  el.style.transform = `translate3d(${n.x}px,${n.y}px,0)`;
  el.style.setProperty('--size', SIZE[role] + 'px');
  el.style.setProperty('--w', WIDTH[role] + 'px');
  el.style.setProperty('--accent', accentOf(n, g));
  el.style.setProperty('--cat', (CATEGORIES[n.category] || CATEGORIES.other).color);
  el.style.setProperty('--p', progressPct(n, g));
  el.dataset.state = st;
  el.querySelector('.orb-icon').textContent  = n.icon || '⭐';
  el.querySelector('.node-title').textContent = n.title || 'Без назви';
  el.querySelector('.orb-badge').textContent  = st === 'done' ? '✓' : st === 'locked' || st === 'ready' ? '🔒' : '';

  const meta = el.querySelector('.node-meta');
  const t = n.milestones.length, d = n.milestones.filter(m => m.done).length;
  const miss = g.left.get(n.id);
  if (st === 'locked' || st === 'ready') {
    meta.textContent = `${miss} ${plural(miss, 'блокер', 'блокери', 'блокерів')}`;
    meta.classList.add('blocked');
  } else {
    meta.textContent = st === 'done' ? '✓' : t ? `${d}/${t}` : '';
    meta.classList.remove('blocked');
  }
  el.classList.toggle('sel', selection.has(n.id));
}
const nodeEl = id => nodeEls.get(id);
const radiusOf = (id, g) => SIZE[g.role.get(id)] / 2;

/* --- стрілки --- */
function renderEdges() {
  const g = graph();
  const seen = new Set();
  for (const e of state.edges) {
    if (!getNode(e.from) || !getNode(e.to)) continue;
    seen.add(e.id);
    let refs = edgeEls.get(e.id);
    if (!refs) {
      const gEl = svgEl('g', { 'data-id': e.id });
      const hit = svgEl('path', { class: 'edge-hit' });
      const path = svgEl('path', { class: 'edge' });
      gEl.append(hit, path);
      edgeLayer.appendChild(gEl);
      refs = { g: gEl, path, hit, label: null };
      edgeEls.set(e.id, refs);
    }
    if (e.label && !refs.label) { refs.label = svgEl('text', { class: 'edge-label' }); refs.g.append(refs.label); }
    if (!e.label && refs.label) { refs.label.remove(); refs.label = null; }
    if (refs.label) refs.label.textContent = e.label;
  }
  for (const [id, refs] of edgeEls) if (!seen.has(id)) { refs.g.remove(); edgeEls.delete(id); }
  updateEdgePaths();
}

function updateEdgePaths() {
  const g = graph();
  for (const e of state.edges) {
    const refs = edgeEls.get(e.id); if (!refs) continue;
    const a = getNode(e.from), b = getNode(e.to); if (!a || !b) continue;
    const geo = elbow(a, b, radiusOf(a.id, g), radiusOf(b.id, g));
    refs.path.setAttribute('d', geo.d);
    refs.hit.setAttribute('d', geo.d);
    refs.path.setAttribute('class', 'edge'
      + (g.done.get(a.id) ? ' from-done' : ' blocked')
      + (selEdge === e.id ? ' sel' : ''));
    refs.path.setAttribute('marker-end', selEdge === e.id ? 'url(#ah-sel)' : 'url(#ah)');
    if (refs.label) { refs.label.setAttribute('x', geo.mx); refs.label.setAttribute('y', geo.my - 5); }
  }
}

/** Зʼєднання «сходинкою» з округленими кутами: від низу блокера
    до верху цілі. Якщо ціль опинилась вище (вільний режим) — дуга. */
function elbow(a, b, ra, rb) {
  const sx = a.x, sy = a.y + ra + 2;
  const ex = b.x, ey = b.y - rb - 9;
  if (ey - sy < 26) {                       // нестандартне взаємне розміщення
    const dx = ex - sx, dy = ey - sy;
    const d = Math.hypot(dx, dy) || 1;
    const bow = Math.min(70, d * 0.18);
    const cx = (sx + ex) / 2 - (dy / d) * bow, cy = (sy + ey) / 2 + (dx / d) * bow;
    return { d: `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`, mx: (sx + 2 * cx + ex) / 4, my: (sy + 2 * cy + ey) / 4 };
  }
  const my = (sy + ey) / 2;
  if (Math.abs(ex - sx) < 2) return { d: `M${sx},${sy} L${ex},${ey}`, mx: sx, my };
  const dir = ex > sx ? 1 : -1;
  const r = Math.min(20, Math.abs(ex - sx) / 2, (ey - sy) / 2);
  return {
    d: `M${sx},${sy} L${sx},${my - r} Q${sx},${my} ${sx + dir * r},${my} `
     + `L${ex - dir * r},${my} Q${ex},${my} ${ex},${my + r} L${ex},${ey}`,
    mx: (sx + ex) / 2, my,
  };
}

/* --- «коридори» гілок: візуальне розділення цілей --- */
function renderLanes() {
  laneLayer.textContent = '';
  const g = graph();
  if (!state.auto || g.sinkIdx.size < 2) return;

  const boxes = new Map();
  for (const n of state.nodes) {
    const b = g.branch.get(n.id);
    const r = SIZE[g.role.get(n.id)] / 2 + 12;
    const box = boxes.get(b) || { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity, n: 0 };
    box.x1 = Math.min(box.x1, n.x - r); box.x2 = Math.max(box.x2, n.x + r);
    box.y1 = Math.min(box.y1, n.y - r); box.y2 = Math.max(box.y2, n.y + r + 34);
    box.n++;
    boxes.set(b, box);
  }

  /* Малюємо коридор лише навколо гілок, які реально стоять окремо:
     якщо ачівка веде одразу до двох цілей, рамки накладаються — тоді
     від них більше шуму, ніж користі, і ми їх пропускаємо. */
  const goalTitle = new Map();
  for (const [sinkId, i] of g.sinkIdx) goalTitle.set(i, getNode(sinkId));
  for (const [b, box] of boxes) {
    if (box.n < 3) continue;
    const overlaps = [...boxes].some(([o, ob]) => o !== b && ob.x1 < box.x2 + 20 && box.x1 < ob.x2 + 20);
    if (overlaps) continue;
    const hue = BRANCH_HUES[b % BRANCH_HUES.length];
    laneLayer.appendChild(svgEl('rect', {
      class: 'lane', x: box.x1 - 14, y: box.y1 - 30,
      width: box.x2 - box.x1 + 28, height: box.y2 - box.y1 + 44,
      rx: 26, fill: hue, 'fill-opacity': .05,
      stroke: hue, 'stroke-opacity': .20, 'stroke-dasharray': '10 8',
    }));
    const goal = goalTitle.get(b);
    if (goal) {
      const label = svgEl('text', { class: 'lane-label', x: (box.x1 + box.x2) / 2, y: box.y1 - 40, fill: hue });
      label.textContent = `${goal.icon} ${goal.title}`;
      laneLayer.appendChild(label);
    }
  }
}

function renderStats() {
  const g = graph();
  const total = state.nodes.length;
  const done  = state.nodes.filter(n => g.st.get(n.id) === 'done').length;
  $('#progressChip .chip-txt').textContent = `${done}/${total}`;
  $('#progressChip .chip-bar i').style.width = (total ? done / total * 100 : 0) + '%';
  $('#btnUndo').disabled = !past.length;
  $('#btnRedo').disabled = !future.length;
  renderNext();
}

/* --- панель «доступно зараз» --- */
function renderNext() {
  const g = graph();
  const open = state.nodes
    .filter(n => g.st.get(n.id) === 'open')
    .sort((a, b) => progressPct(b, g) - progressPct(a, g) || a.title.localeCompare(b.title));
  $('#nextCount').textContent = open.length;
  const list = $('#nextList');
  if (list.hidden) return;
  list.textContent = '';
  if (!open.length) {
    list.innerHTML = `<div class="next-empty">Доступних ачівок немає — закрий блокери вище або додай нові кроки.</div>`;
    return;
  }
  for (const n of open) {
    const b = document.createElement('button');
    b.className = 'next-item';
    const t = n.milestones.length, d = n.milestones.filter(m => m.done).length;
    b.innerHTML = `<span class="ico">${esc(n.icon)}</span><span class="t">${esc(n.title)}</span>`
                + `<span class="p">${t ? `${d}/${t}` : ''}</span>`;
    b.addEventListener('click', () => { centerOn(n.id); selection = new Set([n.id]); selEdge = null; syncSelection(); });
    list.appendChild(b);
  }
}

/* --- фільтр / пошук / фокус --- */
function updateVisibility() {
  const g = graph();
  const q = filter.q.trim().toLowerCase();
  const focusBranch = focusMode && selection.size
    ? g.branch.get([...selection][0])
    : null;

  for (const n of state.nodes) {
    const el = nodeEl(n.id); if (!el) continue;
    const inCat = filter.cats.has(n.category);
    const inSt  = filter.stats.has(g.st.get(n.id));
    const inFoc = focusBranch == null || g.branch.get(n.id) === focusBranch;
    const hit = !!q && (n.title + ' ' + n.desc + ' ' + n.milestones.map(m => m.text).join(' '))
                        .toLowerCase().includes(q);
    el.classList.toggle('hidden-f', !inCat || !inSt);
    el.classList.toggle('dim', !inFoc || (!!q && !hit));
    el.classList.toggle('hit', hit);
  }
  for (const e of state.edges) {
    const refs = edgeEls.get(e.id); if (!refs) continue;
    const vis = focusBranch == null || g.branch.get(e.from) === focusBranch || g.branch.get(e.to) === focusBranch;
    refs.g.style.opacity = vis ? '' : '.12';
  }
}

/* ---------------- 6) ВʼЮПОРТ ---------------- */
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
  /* поки контейнер не має реального розміру (перший кадр, згорнута панель),
     рахувати масштаб немає сенсу — пробуємо наступного кадру */
  if (viewportEl.getBoundingClientRect().width < 80) {
    requestAnimationFrame(fitView);
    return;
  }
  const g = graph();
  const pad = 120;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const n of state.nodes) {
    const r = SIZE[g.role.get(n.id)] / 2;
    x1 = Math.min(x1, n.x - r - 60); x2 = Math.max(x2, n.x + r + 60);
    y1 = Math.min(y1, n.y - r);      y2 = Math.max(y2, n.y + r + 46);
  }
  const r = viewportEl.getBoundingClientRect();
  const s = clamp(Math.min((r.width - pad) / (x2 - x1), (r.height - pad) / (y2 - y1)), MIN_Z, 1.3);
  view.scale = s;
  view.x = r.width / 2 - (x1 + x2) / 2 * s;
  view.y = r.height / 2 - (y1 + y2) / 2 * s;
  applyView(); saveSoon();
}
/** Якщо збережена панорама не показує жодної ачівки (відкрили з іншого
    пристрою, змінилась орієнтація) — показуємо дошку цілком. */
function ensureVisible() {
  const r = viewportEl.getBoundingClientRect();
  if (r.width < 80) { requestAnimationFrame(ensureVisible); return; }
  if (!state.nodes.length) return;
  /* Порівнюємо екранні габарити дошки з вікном: панораму зі старого
     пристрою треба поправити і коли дошка вилазить за екран, і коли
     вона зіщулилась у куточку. Між цим — залишаємо як було. */
  const xs = state.nodes.map(n => view.x + n.x * view.scale);
  const ys = state.nodes.map(n => view.y + n.y * view.scale);
  const w = Math.max(...xs) - Math.min(...xs) + 160 * view.scale;
  const h = Math.max(...ys) - Math.min(...ys) + 160 * view.scale;
  const outside = Math.min(...xs) < 0 || Math.max(...xs) > r.width
               || Math.min(...ys) < 0 || Math.max(...ys) > r.height;
  const tooSmall = w < r.width * 0.35 && h < r.height * 0.35;
  if (outside || tooSmall) fitView();
}

/** Плавно підвести камеру до конкретної ачівки. */
function centerOn(id) {
  const n = getNode(id); if (!n) return;
  const r = viewportEl.getBoundingClientRect();
  view.x = r.width / 2 - n.x * view.scale;
  view.y = r.height / 2 - n.y * view.scale;
  applyView(); saveSoon();
}

const toWorld = (cx, cy) => {
  const r = viewportEl.getBoundingClientRect();
  return { x: (cx - r.left - view.x) / view.scale, y: (cy - r.top - view.y) / view.scale };
};
const toScreen = (x, y) => {
  const r = viewportEl.getBoundingClientRect();
  return { x: r.left + view.x + x * view.scale, y: r.top + view.y + y * view.scale };
};

/* ---------------- 7) ІНСТРУМЕНТИ ---------------- */
function setTool(t) {
  tool = t;
  cancelLink();
  $$('.tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  canvas.className = 't-' + t;
}
$$('.tool[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

$('#btnFit').addEventListener('click', fitView);
$('#btnTidy').addEventListener('click', () => { withHistory(() => tidy()); toast('Дерево впорядковано'); });
$('#btnAuto').addEventListener('click', () => {
  state.auto = !state.auto;
  paintModes();
  if (state.auto) { withHistory(() => tidy()); toast('Авто-розкладка увімкнена — дерево тримає форму саме'); }
  else { saveSoon(); toast('Вільний режим — тепер кружечки можна тягати вручну'); }
});
$('#btnFocus').addEventListener('click', () => {
  focusMode = !focusMode;
  paintModes();
  if (focusMode && !selection.size) toast('Обери ачівку — і залишиться видимою лише її гілка');
  updateVisibility();
});
function paintModes() {
  $('#btnAuto').classList.toggle('on', state.auto);
  $('#btnFocus').classList.toggle('on', focusMode);
  $('#btnTidy').disabled = false;
}

/* ---------------- 8) ПОДІЇ ПОЛЯ ---------------- */
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
  if (e.shiftKey) { view.x -= e.deltaY; applyView(); saveSoon(); return; }
  const r = viewportEl.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, view.scale * Math.exp(-e.deltaY * 0.0016));
}, { passive: false });

canvas.addEventListener('dblclick', e => {
  if (e.target.closest('.node')) return;
  if (recentTouchTap()) return;
  openNodeEditor(null, toWorld(e.clientX, e.clientY));
});

function onCanvasDown(e) {
  hideCtx(); closeTopMenus();
  if (pinch) return;
  const touch = e.pointerType === 'touch';
  const panning = e.button === 2 || e.button === 1 || (e.button === 0 && (tool === 'hand' || spaceDown));
  if (panning) { e.preventDefault(); startPan(e); return; }
  if (e.button !== 0) return;

  if (linkFrom) {
    const finish = ev => {
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = under && under.closest('.node');
      finishConnect(linkFrom, toWorld(ev.clientX, ev.clientY), target && target.dataset.id);
    };
    if (touch) { startPan(e, finish); return; }
    finish(e); return;
  }
  if (e.target.closest('.node')) return;

  if (tool === 'add') {
    if (touch) { startPan(e, ev => openNodeEditor(null, toWorld(ev.clientX, ev.clientY))); return; }
    openNodeEditor(null, toWorld(e.clientX, e.clientY));
    return;
  }
  if (tool === 'link') { toast('Тапни по ачівці, від якої тягнути стрілку'); return; }

  if (touch) { startPan(e, onCanvasTap); armLongPress(e); return; }
  startMarquee(e);
}

function endActiveDrag() {
  const a = activeDrag; activeDrag = null;
  if (a) a.cancel();
}

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
    activeDrag = null; saveSoon();
    if (tapEv && !moved && onTap) onTap(tapEv);
  };
  const up = ev => done(ev), cancel = () => done(null);
  activeDrag = { cancel };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

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
    activeDrag = null; box.hidden = true;
    if (!ev) return;
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
  for (const [id, el] of nodeEls) el.classList.toggle('sel', selection.has(id));
  updateEdgePaths();
  updateVisibility();
}

/* --- ачівки: перетягування, клік, ручки --- */
nodesEl.addEventListener('pointerdown', e => {
  const el = e.target.closest('.node'); if (!el) return;
  const n = getNode(el.dataset.id); if (!n) return;
  if (e.button !== 0 || pinch || linkFrom) return;
  e.stopPropagation();

  const handle = e.target.closest('.handle');
  if (handle) { startDragConnect(e, n, handle.dataset.h === 'b' ? 'down' : 'up'); return; }
  if (tool === 'link') { beginLink(n.id, 'up'); return; }
  startNodeDrag(e, n, el);
});
nodesEl.addEventListener('dblclick', e => {
  if (TOUCH) return;
  const el = e.target.closest('.node');
  if (el) { e.stopPropagation(); openDetails(el.dataset.id); }
});

function startNodeDrag(e, n, el) {
  endActiveDrag();
  if (!selection.has(n.id)) { selection = new Set([n.id]); selEdge = null; syncSelection(); }

  /* в авто-режимі позиції рахує алгоритм — тягнути нема сенсу,
     тому клік просто відкриває меню ачівки */
  if (state.auto) {
    const up = ev => {
      window.removeEventListener('pointerup', up);
      activeDrag = null;
      if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 6) showNodeMenu(n.id);
    };
    activeDrag = { cancel: () => window.removeEventListener('pointerup', up) };
    window.addEventListener('pointerup', up);
    return;
  }

  const ids = [...selection];
  const start = ids.map(id => { const m = getNode(id); return { id, x: m.x, y: m.y }; });
  const p0 = toWorld(e.clientX, e.clientY);
  const before = snapshot();
  let moved = false, raf = 0;
  const els = ids.map(id => nodeEl(id)).filter(Boolean);
  els.forEach(x => x.classList.remove('anim'));    // без transition, поки тягнемо

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
      if (mel) mel.style.transform = `translate3d(${m.x}px,${m.y}px,0)`;
    }
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; updateEdgePaths(); });
  };
  const finish = allowMenu => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    activeDrag = null;
    el.classList.remove('dragging');
    els.forEach(x => x.classList.add('anim'));
    if (moved) { past.push(before); future.length = 0; renderLanes(); saveSoon(); }
    else if (allowMenu) showNodeMenu(n.id);
  };
  const up = () => finish(true), cancel = () => finish(false);
  activeDrag = { cancel };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

/* ---------------- 8.5) ТАЧ / ЖЕСТИ ---------------- */
const TOUCH = matchMedia('(pointer: coarse)').matches;
let lastTap = 0, lastTapPt = { x: 0, y: 0 }, lastTouchTapAt = 0;
const recentTouchTap = () => Date.now() - lastTouchTapAt < 700;

function onCanvasTap(ev) {
  if (ctxWasOpen) { ctxWasOpen = false; lastTap = 0; return; }
  const now = Date.now();
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

function armLongPress(e) {
  const sx = e.clientX, sy = e.clientY;
  let timer = setTimeout(() => {
    timer = 0; off();
    if (pinch) return;
    endActiveDrag(); lastTap = 0;
    try { navigator.vibrate && navigator.vibrate(12); } catch (err) {}
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
  view.scale = s; view.x = m.x - pinch.wx * s; view.y = m.y - pinch.wy * s;
  applyView();
}, { passive: false });
const endPinch = e => {
  if (!pinch || e.touches.length >= 2) return;
  pinch = null; lastTap = 0; lastTouchTapAt = Date.now();
  saveSoon();
};
canvas.addEventListener('touchend', endPinch);
canvas.addEventListener('touchcancel', endPinch);

/* ---------------- 9) ЗВʼЯЗКИ ---------------- */
/** dir='up'   — тягнемо вгору: новий вузол стане блокером цього.
    dir='down' — тягнемо вниз: цей вузол стане блокером нового. */
function startDragConnect(e, from, dir) {
  hideCtx(); endActiveDrag();
  linkDir = dir;
  let dropped = false;
  const mv = ev => drawTemp(from, toWorld(ev.clientX, ev.clientY));
  const up = ev => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    activeDrag = null; clearTemp();
    if (dropped || !ev) return; dropped = true;
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
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

function beginLink(id, dir) {
  linkFrom = id; linkDir = dir || 'up';
  toast(linkDir === 'up'
    ? 'Клікни, де поставити крок-блокер — або по існуючій ачівці. Esc — скасувати'
    : 'Клікни по цілі, яку відкриває ця ачівка. Esc — скасувати');
  drawTemp(getNode(id), cursorWorld);
}
function cancelLink() { linkFrom = null; clearTemp(); }

function finishConnect(fromId, point, targetId) {
  const dir = linkDir;
  cancelLink();
  const from = getNode(fromId); if (!from) return;
  if (targetId === fromId) return;
  if (targetId) {
    dir === 'up' ? addEdge(targetId, fromId) : addEdge(fromId, targetId);
    return;
  }
  /* кинули в пусте місце — створюємо нову ачівку і одразу звʼязуємо */
  openNodeEditor(null, point, newId => {
    dir === 'up' ? addEdge(newId, fromId) : addEdge(fromId, newId);
  }, from);
}

function addEdge(from, to) {
  if (from === to) return;
  if (state.edges.some(e => e.from === from && e.to === to)) { toast('Такий звʼязок уже є'); return; }
  if (wouldCycle(from, to)) { toast('Так вийде замкнене коло залежностей — ціль ніколи не розблокується'); return; }
  withHistory(() => state.edges.push({ id: uid(), from, to, label: '' }));
}

function drawTemp(from, p) {
  if (!from) return;
  clearTemp();
  const g = graph();
  const a = linkDir === 'up' ? { x: p.x, y: p.y } : from;
  const b = linkDir === 'up' ? from : { x: p.x, y: p.y };
  const geo = elbow(a, b, linkDir === 'up' ? 40 : radiusOf(from.id, g), linkDir === 'up' ? radiusOf(from.id, g) : 40);
  tempLayer.append(
    svgEl('path', { class: 'temp-edge', d: geo.d, 'marker-end': 'url(#ah-sel)' }),
    svgEl('circle', { class: 'temp-dot', cx: p.x, cy: p.y, r: 40 })
  );
}
function clearTemp() { tempLayer.textContent = ''; }

/* ---------------- 10) МЕНЮ ---------------- */
function openCtx(clientX, clientY, html, onPick) {
  ctxmenu.innerHTML = html;
  ctxmenu.hidden = false;
  const r = ctxmenu.getBoundingClientRect();
  ctxmenu.style.left = clamp(clientX - r.width / 2, 8, innerWidth - r.width - 8) + 'px';
  ctxmenu.style.top  = clamp(clientY, 8, innerHeight - r.height - 8) + 'px';
  ctxmenu.onclick = ev => {
    const b = ev.target.closest('button[data-a]'); if (!b || b.disabled) return;
    hideCtx(); onPick(b.dataset.a);
  };
}
function hideCtx() { ctxmenu.hidden = true; }
let ctxWasOpen = false;
window.addEventListener('pointerdown', e => {
  if (e.target.closest('#ctxmenu')) return;
  ctxWasOpen = !ctxmenu.hidden;
  hideCtx();
}, true);

function showNodeMenu(id) {
  const n = getNode(id); if (!n) return;
  const g = graph();
  const st = g.st.get(id), miss = g.left.get(id);
  const p = toScreen(n.x, n.y + radiusOf(id, g) + 42);
  openCtx(p.x, p.y, `
    <div class="cm-head">${esc(n.title)}</div>
    <button data-a="edit">✏️ Редагувати</button>
    <button data-a="details">🔍 Детальніше</button>
    <button data-a="up">⬆ Додати крок-блокер</button>
    <button data-a="down">⬇ Ця ачівка відкриває…</button>
    <button data-a="status" ${st === 'locked' || st === 'ready' ? '' : ''}>
      ${st === 'done' ? '🔓 Зняти «отримано»' : '🏅 Позначити отриманою'}
      ${miss ? `<span class="k">🔒 ${miss}</span>` : ''}
    </button>
    <button data-a="dup">⧉ Дублювати</button>
    <button data-a="del" class="danger">🗑 Видалити <span class="k">Del</span></button>
  `, a => {
    if (a === 'edit')    openNodeEditor(id);
    if (a === 'details') openDetails(id);
    if (a === 'up')      beginLink(id, 'up');
    if (a === 'down')    beginLink(id, 'down');
    if (a === 'dup')     duplicateNode(id);
    if (a === 'del')     deleteNodes([id]);
    if (a === 'status')  toggleDone(id);
  });
}

/** Позначити отриманою можна лише те, що не тримають блокери. */
function toggleDone(id) {
  const n = getNode(id); if (!n) return;
  const g = graph();
  if (!n.done && g.locked.get(id)) {
    const names = g.inn.get(id).filter(p => !g.done.get(p)).map(p => getNode(p)?.title).filter(Boolean);
    toast(`Спочатку треба закрити: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`);
    return;
  }
  withHistory(() => {
    n.done = !n.done;
    if (n.done) n.milestones.forEach(m => { m.done = true; });
  });
}

edgeLayer.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const gEl = e.target.closest('g[data-id]'); if (!gEl) return;
  e.stopPropagation();
  selection.clear(); selEdge = gEl.dataset.id; syncSelection();
  const ed = getEdge(selEdge); if (!ed) return;
  const a = getNode(ed.from), b = getNode(ed.to);
  openCtx(e.clientX, e.clientY + 10, `
    <div class="cm-head">${esc(a?.title || '')} → ${esc(b?.title || '')}</div>
    <button data-a="label">🏷 Підпис стрілки</button>
    <button data-a="flip">⇄ Змінити напрямок</button>
    <button data-a="del" class="danger">🗑 Прибрати залежність</button>
  `, act => {
    if (act === 'del')  withHistory(() => { state.edges = state.edges.filter(x => x.id !== ed.id); selEdge = null; });
    if (act === 'flip') {
      if (wouldCycle(ed.to, ed.from)) return toast('Розворот створив би замкнене коло');
      withHistory(() => { const t = ed.from; ed.from = ed.to; ed.to = t; });
    }
    if (act === 'label') {
      const v = prompt('Підпис стрілки (порожньо — прибрати):', ed.label || '');
      if (v !== null) withHistory(() => { ed.label = v.trim(); });
    }
  });
});

function showCanvasMenu(cx, cy) {
  const p = toWorld(cx, cy);
  openCtx(cx, cy, `
    <div class="cm-head">Поле</div>
    <button data-a="add">✨ Нова ачівка тут</button>
    <button data-a="tidy">⤡ Упорядкувати дерево</button>
    <button data-a="all">☑ Виділити все</button>
    <button data-a="fit">⤢ Показати все</button>
  `, a => {
    if (a === 'add')  openNodeEditor(null, p);
    if (a === 'tidy') withHistory(() => tidy());
    if (a === 'fit')  fitView();
    if (a === 'all')  { selection = new Set(state.nodes.map(n => n.id)); selEdge = null; syncSelection(); }
  });
}

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
    const c = normalizeNode({ ...n, id: uid(), x: n.x + 170, y: n.y, title: n.title + ' (копія)' });
    c.milestones = n.milestones.map(m => ({ id: uid(), text: m.text, done: m.done }));
    state.nodes.push(c);
    selection = new Set([c.id]);
  });
}

/* ---------------- 11) МОДАЛКИ ---------------- */
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

/* --- редактор ачівки --- */
function openNodeEditor(id, pos, onCreated, fromNode) {
  const editing = !!id;
  if (!editing && !pos) {
    const r = viewportEl.getBoundingClientRect();
    pos = toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }
  const n = editing ? getNode(id) : {
    title: '', icon: pickIcon(), desc: '', milestones: [], done: false,
    category: fromNode ? fromNode.category : 'personal',
  };
  if (editing && !n) return;
  const g = graph();
  const locked = editing && g.locked.get(id);

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
      <input type="text" class="icon-search" id="fIconQ" placeholder="Пошук емблеми: гроші, спорт, книга…">
      <div class="icon-tabs" id="fTabs">
        ${Object.keys(ICON_GROUPS).map((k, i) => `<button type="button" data-g="${k}" class="${i === 0 ? 'on' : ''}">${k}</button>`).join('')}
      </div>
      <div class="icon-grid" id="fGrid"></div>
      <div class="row2" style="margin-top:14px">
        <div class="field">
          <label>Категорія</label>
          <select id="fCat">
            ${Object.entries(CATEGORIES).map(([k, v]) =>
              `<option value="${k}" ${k === n.category ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Стан</label>
          <label class="f-row" style="padding:9px 0">
            <input type="checkbox" id="fDone" ${n.done ? 'checked' : ''} ${locked ? 'disabled' : ''}>
            Отримано
          </label>
          ${locked ? `<div class="hintline">Спершу треба закрити блокери — вони показані у «Детальніше».</div>` : ''}
        </div>
      </div>
      <div class="field">
        <label>Опис</label>
        <textarea id="fDesc" placeholder="Що саме означає ця ачівка і як зрозуміти, що вона досягнута…">${esc(n.desc)}</textarea>
      </div>
      <div class="field" style="margin-bottom:0">
        <label>Кроки всередині ачівки (milestones)</label>
        <div class="ms-list" id="fMs"></div>
        <button class="btn ghost" id="fMsAdd" style="margin-top:8px">+ Додати milestone</button>
        <button class="btn ghost" id="fAI" style="margin-top:8px">✨ Запропонувати кроки (AI)</button>
      </div>`,
    footer: `
      ${editing ? '<button class="btn danger" id="fDel">Видалити</button>' : ''}
      <div style="flex:1"></div>
      <button class="btn" data-close>Скасувати</button>
      <button class="btn primary" id="fSave">${editing ? 'Зберегти' : 'Створити'}</button>`,
  });

  /* --- пікер емблем: вкладки + пошук --- */
  let group = Object.keys(ICON_GROUPS)[0];
  const grid = $('#fGrid', m);
  const paintGrid = () => {
    const q = $('#fIconQ', m).value.trim().toLowerCase();
    const list = q ? ICONS : ICON_GROUPS[group];
    const cur = $('#fIcon', m).value;
    grid.innerHTML = list.map(i => `<button type="button" data-i="${i}" class="${i === cur ? 'on' : ''}">${i}</button>`).join('');
  };
  paintGrid();
  $('#fTabs', m).addEventListener('click', ev => {
    const b = ev.target.closest('button[data-g]'); if (!b) return;
    group = b.dataset.g;
    $$('#fTabs button', m).forEach(x => x.classList.toggle('on', x === b));
    $('#fIconQ', m).value = '';
    paintGrid();
  });
  $('#fIconQ', m).addEventListener('input', paintGrid);
  grid.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-i]'); if (!b) return;
    $('#fIcon', m).value = b.dataset.i;
    $('#fPrev', m).textContent = b.dataset.i;
    $$('#fGrid button', m).forEach(x => x.classList.toggle('on', x === b));
  });
  $('#fIcon', m).addEventListener('input', ev => {
    $('#fPrev', m).textContent = ev.target.value || '⭐';
    paintGrid();
  });

  const msWrap = $('#fMs', m);
  n.milestones.forEach(ms => addMsRow(msWrap, ms));
  $('#fMsAdd', m).addEventListener('click', () => {
    addMsRow(msWrap, { id: uid(), text: '', done: false });
    msWrap.lastElementChild.querySelector('input[type=text]').focus();
  });
  $('#fAI', m).addEventListener('click', () => openAIStub($('#fTitle', m).value.trim()));
  if (editing) $('#fDel', m).addEventListener('click', () => { closeModal(); deleteNodes([id]); });

  const save = () => {
    const data = {
      title: $('#fTitle', m).value.trim() || 'Без назви',
      icon:  $('#fIcon', m).value.trim() || '⭐',
      category: $('#fCat', m).value,
      done: $('#fDone', m).checked,
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

/* --- деталі: опис, кроки, блокери, що відкриває --- */
function openDetails(id) {
  const n = getNode(id); if (!n) return;
  const g = graph();
  const cat = CATEGORIES[n.category] || CATEGORIES.other;
  const st  = g.st.get(id);
  const pre = g.inn.get(id).map(getNode).filter(Boolean);
  const nxt = g.out.get(id).map(getNode).filter(Boolean);

  const m = openModal({
    title: '🔍 Деталі ачівки',
    body: `
      <div class="d-head" style="--accent:${accentOf(n, g)}">
        <div class="d-orb" style="--p:${progressPct(n, g)}"><div>${esc(n.icon)}</div></div>
        <div style="min-width:0">
          <h3 class="d-title">${esc(n.title)}</h3>
          <div class="tags">
            <span class="tag"><i class="f-dot" style="background:${cat.color}"></i>${cat.label}</span>
            <span class="tag ${st}" id="dStat">${st === 'done' ? '🏅 ' : st === 'locked' || st === 'ready' ? '🔒 ' : ''}${STATES[st]}</span>
            <span class="tag">${n.milestones.length} milestones</span>
          </div>
        </div>
      </div>
      <div class="d-sec">
        <h4>Опис</h4>
        <div class="d-desc ${n.desc ? '' : 'empty'}">${n.desc ? esc(n.desc) : 'Опису ще немає — додай через «Редагувати».'}</div>
      </div>
      <div class="d-sec">
        <h4>Кроки всередині <span class="pct" id="dPct"></span></h4>
        <div class="bar"><i id="dBar"></i></div>
        <div class="mile" id="dMile"></div>
      </div>
      <div class="d-sec">
        <h4>Блокери — що треба закрити спершу</h4>
        <div class="blockers" id="dPre">
          ${pre.length ? pre.map(p => `
            <div class="blk ${g.done.get(p.id) ? 'ok' : ''}" data-go="${p.id}">
              <span class="ico">${esc(p.icon)}</span>${esc(p.title)}
              <span class="st">${g.done.get(p.id) ? '✓ закрито' : STATES[g.st.get(p.id)]}</span>
            </div>`).join('')
          : `<div class="empty-note">Блокерів немає — ачівку можна брати в роботу одразу.</div>`}
        </div>
      </div>
      ${nxt.length ? `
      <div class="d-sec">
        <h4>Що це відкриває</h4>
        <div class="blockers">
          ${nxt.map(p => `<div class="blk" data-go="${p.id}"><span class="ico">${esc(p.icon)}</span>${esc(p.title)}
            <span class="st">${STATES[g.st.get(p.id)]}</span></div>`).join('')}
        </div>
      </div>` : ''}`,
    footer: `
      <button class="btn ghost" id="dUp">⬆ Крок-блокер</button>
      <div style="flex:1"></div>
      <button class="btn" data-close>Закрити</button>
      <button class="btn primary" id="dEdit">✏️ Редагувати</button>`,
  });

  const mile = $('#dMile', m);
  const paint = () => {
    const t = n.milestones.length, d = n.milestones.filter(x => x.done).length;
    $('#dPct', m).textContent = t ? `${d}/${t} · ${Math.round(d / t * 100)}%` : '';
    $('#dBar', m).style.width = (t ? d / t * 100 : 0) + '%';
  };
  if (!n.milestones.length) {
    mile.innerHTML = `<div class="empty-note">Кроки ще не додані. Відкрий «Редагувати», щоб розписати їх.</div>`;
  } else {
    n.milestones.forEach(ms => {
      const lab = document.createElement('label');
      lab.className = ms.done ? 'done' : '';
      lab.innerHTML = `<input type="checkbox" ${ms.done ? 'checked' : ''}><span>${esc(ms.text)}</span>`;
      lab.querySelector('input').addEventListener('change', ev => {
        withHistory(() => { ms.done = ev.target.checked; });
        lab.classList.toggle('done', ms.done);
        paint();
        const gg = graph();
        const s = gg.st.get(id);
        const el = $('#dStat', m);
        el.className = 'tag ' + s;
        el.textContent = (s === 'done' ? '🏅 ' : s === 'locked' || s === 'ready' ? '🔒 ' : '') + STATES[s];
      });
      mile.appendChild(lab);
    });
  }
  paint();

  $$('[data-go]', m).forEach(el => el.addEventListener('click', () => {
    const go = el.dataset.go;
    closeModal(); centerOn(go);
    selection = new Set([go]); selEdge = null; syncSelection();
  }));
  $('#dEdit', m).addEventListener('click', () => { closeModal(); openNodeEditor(id); });
  $('#dUp', m).addEventListener('click', () => { closeModal(); beginLink(id, 'up'); });
}

/* --- AI: поки що точка розширення, без мережевих викликів --- */
function openAIStub(title) {
  openModal({
    title: '✨ AI-підказки (поки не підключено)',
    body: `
      <p style="margin:0 0 12px; font-size:13.5px; line-height:1.6">
        Ідея: описуєш ціль${title ? ` «<b>${esc(title)}</b>»` : ''} — модель повертає 3–7 кроків,
        які одразу лягають у milestones або в окремі ачівки-блокери.
      </p>
      <p style="margin:0 0 10px; font-size:13.5px; line-height:1.6">
        Чому не ввімкнено зараз: ключ від API не можна тримати у клієнтському коді —
        його побачить будь-хто, хто відкриє сторінку. Потрібен маленький проксі
        (у проєкті вже є тека <code>mcp-server</code> — вона цілком підходить).
      </p>
      <pre class="code">// app.js — точка розширення
const AI = {
  enabled: false,                       // → true, коли зʼявиться проксі
  endpoint: '/api/suggest',             // твій сервер, який тримає ключ
  async suggestSteps(node) {
    const r = await fetch(AI.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: node.title, desc: node.desc })
    });
    return (await r.json()).steps;       // ['крок 1', 'крок 2', …]
  }
};</pre>`,
    footer: `<div style="flex:1"></div><button class="btn primary" data-close>Зрозуміло</button>`,
  });
}

/* --- довідка --- */
function openHelp() {
  if (TOUCH) return openHelpTouch();
  openModal({
    title: '⌨️ Керування',
    body: `<div class="help-grid">
      <kbd>ПКМ</kbd><span>рух полем (затисни й тягни)</span>
      <kbd>Колесо</kbd><span>зум до курсора · <kbd>Shift</kbd>+колесо — вбік</span>
      <kbd>Tab</kbd><span>додати крок-блокер до виділеної ачівки</span>
      <kbd>Клік</kbd><span>по ачівці — меню · <kbd>2×</kbd> — деталі</span>
      <kbd>Тягни +</kbd><span>вгору — новий блокер · вниз — нова ціль</span>
      <kbd>L</kbd><span>авто-розкладка вкл/викл · <kbd>Shift+L</kbd> — упорядкувати</span>
      <kbd>Z</kbd><span>фокус на гілці виділеної ачівки</span>
      <kbd>V / H / A / C</kbd><span>вибір · рука · нова ачівка · стрілка</span>
      <kbd>Del</kbd><span>видалити виділене</span>
      <kbd>Ctrl+Z</kbd><span>відмінити · <kbd>Ctrl+Shift+Z</kbd> повторити</span>
      <kbd>F</kbd><span>показати все · <kbd>0</kbd> — 100%</span>
      <kbd>Esc</kbd><span>скасувати дію / закрити</span>
    </div>
    <div class="d-sec"><h4>Як влаштоване дерево</h4>
      <div class="hintline" style="margin:0">
        Фінальні цілі стоять унизу, кроки до них — вище. Стрілка «крок → ціль» означає,
        що ціль заблокована, поки крок не закритий. Коли всі блокери закриті, ціль сама
        стає доступною і зʼявляється у списку «Доступно зараз».
      </div>
    </div>`,
    footer: `<div style="flex:1"></div><button class="btn primary" data-close>Зрозуміло</button>`,
  });
}
function openHelpTouch() {
  openModal({
    title: '👆 Керування жестами',
    body: `<div class="help-grid">
      <kbd>Тягни</kbd><span>рух по дошці</span>
      <kbd>Два пальці</kbd><span>зум (щипок)</span>
      <kbd>Тап по ачівці</kbd><span>меню: редагувати · деталі · блокер · видалити</span>
      <kbd>Подвійний тап</kbd><span>по пустому полю — нова ачівка</span>
      <kbd>Довгий тап</kbd><span>меню поля: нова ачівка, упорядкувати, масштаб</span>
      <kbd>Тягни +</kbd><span>вгору — новий блокер · вниз — нова ціль</span>
      <kbd>⌗</kbd><span>авто-розкладка · <kbd>◎</kbd> фокус на гілці</span>
    </div>
    <div class="d-sec"><h4>Як влаштоване дерево</h4>
      <div class="hintline" style="margin:0">
        Фінальні цілі — внизу, кроки до них — вище. Поки блокери не закриті,
        ціль лишається сірою із замком.
      </div>
    </div>`,
    footer: `<div style="flex:1"></div><button class="btn primary" data-close>Зрозуміло</button>`,
  });
}

/* ---------------- 12) ПАНЕЛІ, АДАПТИВ, КЛАВІАТУРА, СТАРТ ---------------- */
const MOBILE_MQ = matchMedia('(max-width:820px)');
const topbarEl  = $('#topbar');
const homes     = new Map();
function rememberHome(el) { homes.set(el, { parent: el.parentNode, next: el.nextSibling }); }
function goHome(el) { const h = homes.get(el); if (h) h.parent.insertBefore(el, h.next); }
['#progressChip', '#btnUndo', '#btnRedo'].forEach(s => rememberHome($(s)));
function closeTopMenus() { topbarEl.classList.remove('menu-open'); }

function applyResponsive() {
  const m = MOBILE_MQ.matches;
  document.body.classList.toggle('is-mobile', m);
  if (m) {
    $('#tbMobile').prepend($('#progressChip'));
    $('#leftbar').append($('#btnUndo'), $('#btnRedo'));
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
  else { $('#search').blur(); $('#filterPop').hidden = true; $('#btnFilter').classList.remove('on'); }
});
$('#btnMore').addEventListener('click', () => {
  topbarEl.classList.remove('search-open');
  topbarEl.classList.toggle('menu-open');
});
$('.tb-right').addEventListener('click', e => { if (e.target.closest('.tb-btn')) closeTopMenus(); });
window.addEventListener('pointerdown', e => { if (!e.target.closest('#topbar')) closeTopMenus(); }, true);

$('#nextToggle').addEventListener('click', () => {
  const l = $('#nextList');
  l.hidden = !l.hidden;
  $('#nextToggle').firstChild.textContent = l.hidden ? '▲ ' : '▼ ';
  renderNext();
});

$('#boardName').addEventListener('input', e => { state.name = e.target.value; saveSoon(); });
$('#search').addEventListener('input', e => { filter.q = e.target.value; updateVisibility(); });
$('#searchClear').addEventListener('click', () => { $('#search').value = ''; filter.q = ''; updateVisibility(); });
$('#btnUndo').addEventListener('click', undo);
$('#btnRedo').addEventListener('click', redo);
$('#btnHelp').addEventListener('click', openHelp);
$('#btnColorMode').addEventListener('click', () => {
  state.colorMode = state.colorMode === 'branch' ? 'category' : 'branch';
  render(); saveSoon();
  toast(state.colorMode === 'branch' ? 'Кольори за гілками' : 'Кольори за категоріями');
});
$('#zoomHud').addEventListener('click', e => {
  const z = e.target.dataset.z;
  if (z === 'in') zoomCenter(1.2);
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
  const blob = new Blob([JSON.stringify({ v: 3, ...state }, null, 2)], { type: 'application/json' });
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
      withHistory(() => { adopt(d); });
      $('#boardName').value = state.name;
      fitView(); toast('Дошку імпортовано');
    } catch (err) { toast('Не вдалося прочитати файл'); }
  };
  rd.readAsText(f);
  e.target.value = '';
});

/* фільтр */
$('#btnFilter').addEventListener('click', () => {
  const pop = $('#filterPop');
  if (!pop.hidden) { pop.hidden = true; $('#btnFilter').classList.remove('on'); return; }
  const g = graph();
  const countCat = k => state.nodes.filter(n => n.category === k).length;
  const countSt  = k => state.nodes.filter(n => g.st.get(n.id) === k).length;
  pop.innerHTML = `
    <h4>Категорії</h4>
    ${Object.entries(CATEGORIES).map(([k, v]) => `
      <label class="f-row"><input type="checkbox" data-c="${k}" ${filter.cats.has(k) ? 'checked' : ''}>
      <i class="f-dot" style="background:${v.color}"></i>${v.label}
      <span class="f-count">${countCat(k)}</span></label>`).join('')}
    <h4 style="margin-top:12px">Стан</h4>
    ${Object.entries(STATES).map(([k, v]) => `
      <label class="f-row"><input type="checkbox" data-s="${k}" ${filter.stats.has(k) ? 'checked' : ''}>
      ${v}<span class="f-count">${countSt(k)}</span></label>`).join('')}
    <button class="btn ghost" id="fAll" style="width:100%;margin-top:10px">Показати все</button>`;
  pop.hidden = false;
  $('#btnFilter').classList.add('on');
  pop.onchange = e => {
    const t = e.target;
    const set = t.dataset.c ? filter.cats : filter.stats;
    const key = t.dataset.c || t.dataset.s;
    t.checked ? set.add(key) : set.delete(key);
    updateVisibility();
  };
  $('#fAll').addEventListener('click', () => {
    filter.cats  = new Set(Object.keys(CATEGORIES));
    filter.stats = new Set(Object.keys(STATES));
    $$('input[type=checkbox]', pop).forEach(c => c.checked = true);
    updateVisibility();
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

  /* Tab — швидка побудова дерева: додати блокер до виділеної ачівки */
  if (e.key === 'Tab' && selection.size === 1) {
    e.preventDefault();
    beginLink([...selection][0], 'up');
    return;
  }

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
  if (k === 'l') e.shiftKey ? $('#btnTidy').click() : $('#btnAuto').click();
  if (k === 'z' && !e.ctrlKey && !e.metaKey) $('#btnFocus').click();
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
function pickIcon() { return ICON_GROUPS['Нагороди'][Math.floor(Math.random() * 8)]; }

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ---------------- демо-дошка ---------------- */
function seed() {
  const N = (title, icon, category, done, desc, ms, doneCount = 0) => normalizeNode({
    id: uid(), title, icon, category, done, desc,
    milestones: (ms || []).map((t, i) => ({ id: uid(), text: t, done: done || i < doneCount })),
  });
  const goal = N('Запустити свій продукт', '🚀', 'work', false,
    'Фінальна ціль роадмепу. Розблокується, коли закриті всі три гілки нижче.',
    ['Публічний реліз', 'Перший платний клієнт']);

  const mvp   = N('MVP готовий', '🛠', 'work', false, 'Робочий прототип, який не соромно показати.', ['Каркас', 'Основний сценарій', 'Деплой'], 1);
  const users = N('Перші 10 користувачів', '🤝', 'work', false, 'Живі люди, які реально користуються.', ['5 інтервʼю', '10 реєстрацій'], 1);
  const money = N('Фінансова подушка', '💰', 'finance', false, 'Резерв на 6 місяців — щоб не панікувати.', ['1 місяць', '3 місяці', '6 місяців'], 1);

  const skill = N('Навчитись верстці', '📚', 'learning', true, 'База, без якої MVP не зібрати.', ['HTML/CSS', 'JS основи']);
  const idea  = N('Перевірити ідею', '🧭', 'learning', true, 'Зрозуміти, чи є проблема.', ['10 розмов']);
  const habit = N('Стабільний дохід', '📈', 'finance', false, 'Щоб було з чого відкладати.', ['Підняти ставку', 'Тримати 3 місяці']);

  state.nodes = [goal, mvp, users, money, skill, idea, habit];
  const E = (a, b, label) => ({ id: uid(), from: a.id, to: b.id, label: label || '' });
  state.edges = [
    E(mvp, goal), E(users, goal), E(money, goal),
    E(skill, mvp), E(idea, users), E(habit, money),
  ];
}

/* ---------------- старт ---------------- */
document.documentElement.dataset.theme = localStorage.getItem(THEME_KEY) || 'dark';
const fresh = !load();
if (fresh) seed();
invalidate();
if (state.auto) tidy();
$('#boardName').value = state.name;
applyResponsive();
setTool('select');
paintModes();
applyView();
render();
/* нову або щойно мігровану дошку показуємо цілком; збережену панораму — лишаємо */
if (fresh || migrated) { fitView(); saveSoon(); }
else ensureVisible();
if (migrated) toast('Дошку перенесено у нову модель: цілі внизу, кроки вгорі');
initRemote();
window.addEventListener('resize', applyView);
window.addEventListener('orientationchange', () => setTimeout(() => { applyView(); ensureVisible(); }, 250));
if (!localStorage.getItem('ab.seenHelp3')) { localStorage.setItem('ab.seenHelp3', '1'); setTimeout(openHelp, 400); }
