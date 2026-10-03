// TrenFever — generador de la red ferroviaria de España.
// Une los GTFS de Renfe (Cercanías/Rodalies y AV/LD/MD), Ouigo y FGC con la red de vías de OpenStreetMap:
// cada tren recorre las vías reales (respetando ancho ibérico / estándar / métrico y la alta velocidad),
// cada estación se asigna a su comunidad autónoma y lleva sus vías numeradas.
// Uso: node --max-old-space-size=8192 tools/build-rail.mjs [carpeta_web] [días]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'web'));
const SRC = path.join(ROOT, 'sources');
const DAYS_AHEAD = +(process.argv[3] || 45);
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${m}`);

// ============================================================================
// Utilidades
// ============================================================================
function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const head = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((l) => { const v = parseCsvLine(l); const o = {}; head.forEach((h, i) => (o[h] = (v[i] ?? '').trim())); return o; });
}
async function streamCsv(file, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let ix = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const v = parseCsvLine(line);
    if (!ix) { ix = Object.fromEntries(v.map((h, i) => [h.replace(/^﻿/, '').trim(), i])); continue; }
    onRow(v, ix);
  }
}
const g = (v, ix, k) => (ix[k] === undefined ? '' : (v[ix[k]] ?? '').trim());
const toSec = (t) => { if (!t) return null; const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };
const LAT0 = 40.2, KX = Math.cos((LAT0 * Math.PI) / 180) * 111320, KY = 110540;
const xy = (lon, lat) => [lon * KX, lat * KY];
const dist = (a, b) => Math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY);
const r5 = (n) => Math.round(n * 1e5) / 1e5;
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const P = pts.map(([a, b]) => xy(a, b)), keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let best = -1, bd = tol;
    const [ax, ay] = P[a], [bx, by] = P[b], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    for (let i = a + 1; i < b; i++) {
      let t = ((P[i][0] - ax) * dx + (P[i][1] - ay) * dy) / L2; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(P[i][0] - ax - t * dx, P[i][1] - ay - t * dy); if (d > bd) { bd = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; st.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function cumDist(pts) { const d = [0]; for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + dist(pts[i - 1], pts[i])); return d; }
function projectSeq(pts, cum, points) {
  const S = pts.map(([a, b]) => xy(a, b)); let seg0 = 0, maxOff = 0; const res = [];
  for (const [lo, la] of points) {
    const [px, py] = xy(lo, la); let best = Infinity, bestD = 0, bestSeg = seg0;
    for (let i = seg0; i < S.length - 1; i++) {
      const [ax, ay] = S[i], [bx, by] = S[i + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      let t = ((px - ax) * dx + (py - ay) * dy) / L2; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d < best - 0.01) { best = d; bestSeg = i; bestD = cum[i] + t * (cum[i + 1] - cum[i]); }
    }
    seg0 = bestSeg; res.push(Math.round(bestD)); maxOff = Math.max(maxOff, best);
  }
  return { sd: res, maxOff };
}
function goodFit(r, pts) {
  if (r.maxOff > 400) return false;
  for (let i = 1; i < pts.length; i++) { const geo = dist(pts[i - 1], pts[i]); if (geo > 300 && r.sd[i] - r.sd[i - 1] < 0.5 * geo) return false; }
  return true;
}
const enc = (pts) => { const o = []; let px = 0, py = 0; for (const [x, y] of pts) { const X = Math.round(x * 1e5), Y = Math.round(y * 1e5); o.push(X - px, Y - py); px = X; py = Y; } return o; };
const ymdOf = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const dateOf = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));

// Min-heap para A*
class Heap {
  constructor() { this.k = []; this.v = []; }
  push(key, val) { const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val); while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; } k[i] = key; v[i] = val; }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(); const n = k.length;
    if (n) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; } k[i] = lk; v[i] = lv; }
    return top;
  }
  get size() { return this.k.length; }
}

// ============================================================================
// Comunidades autónomas
// ============================================================================
const CCAA_NAMES = {
  'Andalucia': ['AND', 'Andalucía'], 'Aragon': ['ARA', 'Aragón'], 'Asturias': ['AST', 'Asturias'], 'Baleares': ['BAL', 'Illes Balears'],
  'Canarias': ['CAN', 'Canarias'], 'Cantabria': ['CNT', 'Cantabria'], 'Castilla-La Mancha': ['CLM', 'Castilla-La Mancha'],
  'Castilla-Leon': ['CYL', 'Castilla y León'], 'Cataluña': ['CAT', 'Cataluña'], 'Ceuta': ['CEU', 'Ceuta'], 'Extremadura': ['EXT', 'Extremadura'],
  'Galicia': ['GAL', 'Galicia'], 'La Rioja': ['RIO', 'La Rioja'], 'Madrid': ['MAD', 'Comunidad de Madrid'], 'Melilla': ['MEL', 'Melilla'],
  'Murcia': ['MUR', 'Región de Murcia'], 'Navarra': ['NAV', 'Navarra'], 'Pais Vasco': ['PVA', 'País Vasco'], 'Valencia': ['VAL', 'Comunitat Valenciana'],
};
const ccaaGeo = JSON.parse(fs.readFileSync(path.join(SRC, 'geo', 'comunidades.geojson'), 'utf8'));
const ccaa = ccaaGeo.features.map((f) => {
  const [id, name] = CCAA_NAMES[f.properties.name] || [f.properties.name.slice(0, 3).toUpperCase(), f.properties.name];
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  let minx = 180, miny = 90, maxx = -180, maxy = -90;
  for (const p of polys) for (const [x, y] of p[0]) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
  return { id, name, polys, bbox: [minx, miny, maxx, maxy] };
});
function inRing(x, y, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; }
function ccaaOf(x, y) {
  for (const c of ccaa) {
    if (x < c.bbox[0] || x > c.bbox[2] || y < c.bbox[1] || y > c.bbox[3]) continue;
    for (const p of c.polys) if (inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h))) return c.id;
  }
  // fuera de todos (costa, frontera): la más cercana por bbox
  let best = null, bd = Infinity;
  for (const c of ccaa) { const cx = Math.max(c.bbox[0], Math.min(x, c.bbox[2])), cy = Math.max(c.bbox[1], Math.min(y, c.bbox[3])); const d = dist([x, y], [cx, cy]); if (d < bd) { bd = d; best = c.id; } }
  return best;
}

// Solo la red española: las paradas en Portugal y Francia se quitan (los trenes internacionales se cortan en la
// última estación española). Tolerancia de 700 m para estaciones de costa o de ribera que el polígono deja fuera.
const FOREIGN_NAMES = /Valen[çc]a|Cerb[èe]re|Tor de Querol|Latour|Hendaye|Hendaia/i;
const inSpainCache = new Map();
function inSpain(x, y, name = '') {
  const k = x + ',' + y; if (inSpainCache.has(k)) return inSpainCache.get(k);
  let ok = ccaa.some((c) => x >= c.bbox[0] && x <= c.bbox[2] && y >= c.bbox[1] && y <= c.bbox[3] && c.polys.some((p) => inRing(x, y, p[0])));
  if (!ok && !FOREIGN_NAMES.test(name)) {
    const kx = Math.cos((y * Math.PI) / 180); let m = Infinity;
    for (const c of ccaa) { if (x < c.bbox[0] - 0.02 || x > c.bbox[2] + 0.02 || y < c.bbox[1] - 0.02 || y > c.bbox[3] + 0.02) continue;
      for (const p of c.polys) for (const r of p) for (let i = 1; i < r.length; i++) {
        const ax = r[i - 1][0], ay = r[i - 1][1], dx = (r[i][0] - ax) * kx, dy = r[i][1] - ay, px = (x - ax) * kx, py = y - ay;
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1))); m = Math.min(m, Math.hypot(px - t * dx, py - t * dy) * 111320);
      } }
    ok = m < 700;
  }
  inSpainCache.set(k, ok); return ok;
}

// ============================================================================
// Red de vías (OpenStreetMap) → grafo comprimido
// ============================================================================
// clase de vía: 0 ibérico, 1 estándar, 2 mixto (ibérico+estándar), 3 métrico; + alta velocidad
function gaugeClass(tags) {
  const gs = String(tags.gauge || '').split(/[;,]/).map((x) => parseInt(x, 10)).filter(Boolean);
  const has = (n) => gs.some((x) => Math.abs(x - n) < 15);
  if (tags.railway === 'narrow_gauge' || (has(1000) && !has(1668) && !has(1435))) return 3;
  if (has(1668) && has(1435)) return 2;
  if (has(1435)) return 1;
  if (has(1668)) return 0;
  if (tags.highspeed === 'yes') return 1;
  return 0;
}
log('leyendo vías de OpenStreetMap…');
const nodeIdx = new Map(); const nx = [], ny = [];
const adj = []; // por nodo: [vecino, clase, hs, vecino, clase, hs, ...]
const seenWay = new Set();
const numberedTracks = []; // vías de estación numeradas (railway:track_ref)
const keyOf = (lat, lon) => `${lat.toFixed(7)},${lon.toFixed(7)}`;
function nodeOf(lat, lon) {
  const k = keyOf(lat, lon); let i = nodeIdx.get(k);
  if (i === undefined) { i = nx.length; nodeIdx.set(k, i); nx.push(lon); ny.push(lat); adj.push([]); }
  return i;
}
const tileDir = path.join(SRC, 'osm', 'vias');
let nWays = 0;
for (const f of fs.readdirSync(tileDir).filter((x) => x.endsWith('.json'))) {
  const j = JSON.parse(fs.readFileSync(path.join(tileDir, f), 'utf8'));
  for (const w of j.elements || []) {
    if (w.type !== 'way' || !w.geometry || seenWay.has(w.id)) continue;
    seenWay.add(w.id); nWays++;
    if (w.tags && w.tags['railway:track_ref']) numberedTracks.push({ r: String(w.tags['railway:track_ref']), pts: w.geometry.filter(Boolean).map((p) => [p.lon, p.lat]) });
    const t = w.tags || {}; if (['abandoned', 'proposed', 'razed'].includes(t.railway)) continue;
    const reserve = ['disused', 'construction', 'preserved', 'light_rail', 'tram'].includes(t.railway);
    // hs: 1 = alta velocidad, 2 = escape / apartado, 3 = de reserva (en obras, sin servicio o tren-tranvía)
    const cls = gaugeClass(t), hs = reserve ? 3 : t.highspeed === 'yes' ? 1 : t.service ? 2 : 0;
    let prev = -1;
    for (const p of w.geometry) {
      if (!p) { prev = -1; continue; }
      const i = nodeOf(p.lat, p.lon);
      if (prev >= 0 && prev !== i) { adj[prev].push(i, cls, hs); adj[i].push(prev, cls, hs); }
      prev = i;
    }
  }
}
log(`vías: ${nWays}, nodos: ${nx.length}`);
// Soldadura de huecos del mapeo: un extremo suelto (grado 1) se une al punto de vía más cercano a < 30 m
{
  const G = new Map(), C = 0.0004; // celdas de ~40 m
  for (let i = 0; i < nx.length; i++) { const k = Math.floor(nx[i] / C) + ':' + Math.floor(ny[i] / C); let c = G.get(k); if (!c) G.set(k, (c = [])); c.push(i); }
  let welded = 0;
  for (let i = 0; i < nx.length; i++) {
    if (adj[i].length !== 3) continue; // solo extremos
    const cx = Math.floor(nx[i] / C), cy = Math.floor(ny[i] / C), nb = adj[i][0];
    let best = -1, bd = 30;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of G.get(cx + dx + ':' + (cy + dy)) || []) {
      if (j === i || j === nb) continue;
      const d = dist([nx[i], ny[i]], [nx[j], ny[j]]); if (d < bd) { bd = d; best = j; }
    }
    if (best >= 0 && !adj[i].some((v, q) => q % 3 === 0 && v === best)) { adj[i].push(best, adj[i][1], adj[i][2]); adj[best].push(i, adj[i][1], adj[i][2]); welded++; }
  }
  log(`huecos soldados: ${welded}`);
}
// Huecos grandes del mapeo (puentes o tramos sin dibujar, cortes por obras): un extremo suelto se une, como vía de
// reserva (coste ×6), al punto de vía más cercano a < 400 m que no sea ya alcanzable por la red en poco recorrido.
{
  const C = 0.004, G = new Map();
  for (let i = 0; i < nx.length; i++) { const k = Math.floor(nx[i] / C) + ':' + Math.floor(ny[i] / C); let c = G.get(k); if (!c) G.set(k, (c = [])); c.push(i); }
  const reach = (s, lim) => { // nodos a menos de lim metros por la red
    const seen = new Map([[s, 0]]), q = [s];
    while (q.length) { const u = q.shift(), du = seen.get(u); const a = adj[u];
      for (let k = 0; k < a.length; k += 3) { const v = a[k], dv = du + dist([nx[u], ny[u]], [nx[v], ny[v]]); if (dv <= lim && (!seen.has(v) || seen.get(v) > dv)) { seen.set(v, dv); q.push(v); } } }
    return seen;
  };
  let bridged = 0; const ends = [];
  for (let i = 0; i < nx.length; i++) if (adj[i].length === 3) ends.push(i);
  for (const i of ends) {
    const cx = Math.floor(nx[i] / C), cy = Math.floor(ny[i] / C);
    // dirección en la que "sale" el extremo
    const nb = adj[i][0], ux = (nx[i] - nx[nb]) * Math.cos((ny[i] * Math.PI) / 180), uy = ny[i] - ny[nb], un = Math.hypot(ux, uy) || 1;
    const near = reach(i, 1500);
    let best = -1, bd = 400;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of G.get(cx + dx + ':' + (cy + dy)) || []) {
      if (near.has(j)) continue;
      const d = dist([nx[i], ny[i]], [nx[j], ny[j]]); if (d >= bd || d < 1) continue;
      // hacia delante (±60°), no hacia la vía de al lado
      const vx = (nx[j] - nx[i]) * Math.cos((ny[i] * Math.PI) / 180), vy = ny[j] - ny[i];
      if ((vx * ux + vy * uy) / (un * (Math.hypot(vx, vy) || 1)) < 0.5) continue;
      bd = d; best = j;
    }
    if (best >= 0) { adj[i].push(best, adj[i][1], 3); adj[best].push(i, adj[i][1], 3); bridged++; }
  }
  log(`huecos grandes puenteados: ${bridged}`);
}

// compresión: nodos de cruce = grado ≠ 2 o cambio de clase
const N = nx.length;
const isJ = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  const a = adj[i]; const deg = a.length / 3;
  if (deg !== 2) isJ[i] = 1; else if (a[1] !== a[4] || a[2] !== a[5]) isJ[i] = 1;
}
const jid = new Int32Array(N).fill(-1); let nJ = 0;
for (let i = 0; i < N; i++) if (isJ[i]) jid[i] = nJ++;
// aristas: de cruce a cruce, con la polilínea de nodos
const edges = []; // {a, b (ids de cruce), nodes:[...], len, cls, hs}
const nodeEdge = new Int32Array(N).fill(-1), nodePos = new Float64Array(N); // para nodos intermedios
const jAdj = Array.from({ length: nJ }, () => []);
const visitedDir = new Set();
for (let s = 0; s < N; s++) {
  if (!isJ[s]) continue;
  const a = adj[s];
  for (let k = 0; k < a.length; k += 3) {
    const first = a[k]; const key = s * 4194304 + first; // clave de dirección
    if (visitedDir.has(key)) continue;
    const nodes = [s, first]; let prev = s, cur = first, len = dist([nx[s], ny[s]], [nx[first], ny[first]]);
    const cls = a[k + 1], hs = a[k + 2];
    while (!isJ[cur]) {
      const c = adj[cur]; const nxt = c[0] === prev ? c[3] : c[0];
      len += dist([nx[cur], ny[cur]], [nx[nxt], ny[nxt]]);
      prev = cur; cur = nxt; nodes.push(cur);
      if (nodes.length > 200000) break;
    }
    visitedDir.add(key); visitedDir.add(cur * 4194304 + nodes[nodes.length - 2]);
    const e = edges.length; edges.push({ a: jid[s], b: jid[cur], nodes, len, cls, hs });
    jAdj[jid[s]].push(e); if (jid[cur] !== jid[s]) jAdj[jid[cur]].push(e);
    let acc = 0;
    for (let q = 1; q < nodes.length - 1; q++) { acc += dist([nx[nodes[q - 1]], ny[nodes[q - 1]]], [nx[nodes[q]], ny[nodes[q]]]); nodeEdge[nodes[q]] = e; nodePos[nodes[q]] = acc; }
  }
}
const jNode = new Int32Array(nJ); for (let i = 0; i < N; i++) if (isJ[i]) jNode[jid[i]] = i;
log(`grafo: ${nJ} cruces, ${edges.length} tramos`);

// índice espacial de nodos (celdas de ~1 km)
const CELL = 0.01, grid = new Map();
for (let i = 0; i < N; i++) { const k = Math.floor(nx[i] / CELL) + ':' + Math.floor(ny[i] / CELL); let c = grid.get(k); if (!c) grid.set(k, (c = [])); c.push(i); }
function nearNodes(lon, lat, radius) {
  const out = [], r = Math.ceil(radius / 800);
  const cx = Math.floor(lon / CELL), cy = Math.floor(lat / CELL);
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
    const c = grid.get(cx + dx + ':' + (cy + dy)); if (!c) continue;
    for (const i of c) { const d = dist([lon, lat], [nx[i], ny[i]]); if (d <= radius) out.push([i, d]); }
  }
  return out.sort((a, b) => a[1] - b[1]);
}

// índice de segmentos de vía: ¿un trazado del GTFS va de verdad sobre las vías?
const SEGC = 0.005, segGrid = new Map();
for (let i = 0; i < N; i++) { const a = adj[i]; for (let k = 0; k < a.length; k += 3) { const j = a[k]; if (j < i) continue;
  const x0 = Math.floor(Math.min(nx[i], nx[j]) / SEGC), x1 = Math.floor(Math.max(nx[i], nx[j]) / SEGC), y0 = Math.floor(Math.min(ny[i], ny[j]) / SEGC), y1 = Math.floor(Math.max(ny[i], ny[j]) / SEGC);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const c = x + ':' + y; let g = segGrid.get(c); if (!g) segGrid.set(c, (g = [])); g.push(i, j); } } }
function nearTrack(p, r) {
  const kx = Math.cos((p[1] * Math.PI) / 180), cx = Math.floor(p[0] / SEGC), cy = Math.floor(p[1] / SEGC);
  for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) { const g = segGrid.get(x + ':' + y); if (!g) continue;
    for (let q = 0; q < g.length; q += 2) { const ax = nx[g[q]], ay = ny[g[q]], dx = (nx[g[q + 1]] - ax) * kx, dy = ny[g[q + 1]] - ay, px = (p[0] - ax) * kx, py = p[1] - ay;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1))); if (Math.hypot(px - t * dx, py - t * dy) * 111320 < r) return true; } }
  return false;
}
// ¿el trazado (muestreado cada 25 m) va sobre las vías? falla si menos del 97 % está a < 12 m de una vía
// o si hay un tramo seguido de más de 60 m fuera de ellas (el tren iría junto a la vía, no encima)
function offTrack(poly) {
  let n = 0, ok = 0, run = 0, worst = 0;
  for (let i = 1; i < poly.length; i++) { const d = dist(poly[i - 1], poly[i]), m = Math.max(1, Math.ceil(d / 25));
    for (let q = 0; q < m; q++) { const t = q / m; n++;
      if (nearTrack([poly[i - 1][0] + (poly[i][0] - poly[i - 1][0]) * t, poly[i - 1][1] + (poly[i][1] - poly[i - 1][1]) * t], 12)) { ok++; run = 0; } else { run += d / m; worst = Math.max(worst, run); } } }
  return (n ? ok / n : 1) < 0.97 || worst > 60;
}

// perfiles de coste por tipo de tren: multiplicador según clase de vía [ibérico, estándar, mixto, métrico]
const PROFILES = {
  any: { c: [1.0, 1.6, 1.0, 1.0], hs: 1.3 },     // Cercanías: camino físico más corto en cualquier ancho
  ave: { c: [3.0, 1.0, 1.0, 60], hs: 0.85 },   // AVE, AVLO, Ouigo, Euromed, Avant: prefiere alta velocidad
  mix: { c: [1.0, 1.05, 1.0, 60], hs: 0.95 },   // Alvia, Intercity: cambian de ancho
  ib: { c: [1.0, 4.0, 1.0, 60], hs: 2.5 },       // Cercanías, MD, Regional: red convencional
  met: { c: [40, 40, 40, 1.0], hs: 40 },         // ancho métrico (Feve, FGC Llobregat-Anoia)
  std: { c: [30, 1.0, 1.0, 40], hs: 1.0 },       // FGC Barcelona-Vallès (ancho estándar)
};
const hsF = (hs, pr) => (hs === 1 ? PROFILES[pr].hs : hs === 2 ? 2.5 : hs === 3 ? 6 : 1);
const edgeCost = (e, pr) => e.len * PROFILES[pr].c[e.cls] * hsF(e.hs, pr);

// punto de enganche de una estación para un perfil: nodo cercano de la clase más barata
const snapCache = new Map();
function snap(lon, lat, pr) {
  const k = lon + ',' + lat + ',' + pr; if (snapCache.has(k)) return snapCache.get(k);
  let best = null, bs = Infinity;
  for (const [i, d] of nearNodes(lon, lat, 900)) {
    let cls, hs;
    if (isJ[i]) { const e = edges[jAdj[jid[i]][0]]; if (!e) continue; cls = e.cls; hs = e.hs; } else { const e = edges[nodeEdge[i]]; if (!e) continue; cls = e.cls; hs = e.hs; }
    const score = d * 1 + 400 * PROFILES[pr].c[cls] * hsF(hs, pr);
    if (score < bs) { bs = score; best = i; }
  }
  snapCache.set(k, best); return best;
}
// puntos de salida desde un nodo: lista de [cruce, coste, fragmento de nodos desde el nodo hasta el cruce]
function exits(i, pr) {
  if (isJ[i]) return [[jid[i], 0, [i]]];
  const e = edges[nodeEdge[i]]; const p = e.nodes.indexOf(i);
  const toA = e.nodes.slice(0, p + 1).reverse(), toB = e.nodes.slice(p);
  const f = PROFILES[pr].c[e.cls] * hsF(e.hs, pr);
  return [[e.a, nodePos[i] * f, toA], [e.b, (e.len - nodePos[i]) * f, toB]];
}
// rumbos (vectores unitarios en metros locales) de una secuencia de nodos: al salir del primero y al llegar al último,
// medidos sobre ~30 m para no depender del último segmento corto del mapeo
const KXg = Math.cos((40 * Math.PI) / 180);
function headOut(nodes) {
  const x0 = nx[nodes[0]], y0 = ny[nodes[0]]; let q = 1, d = 0;
  while (q < nodes.length - 1 && (d = dist([x0, y0], [nx[nodes[q]], ny[nodes[q]]])) < 30) q++;
  if (q >= nodes.length) return null;
  const vx = (nx[nodes[q]] - x0) * KXg, vy = ny[nodes[q]] - y0, l = Math.hypot(vx, vy); return l ? [vx / l, vy / l] : null;
}
const headIn = (nodes) => { const h = headOut(nodes.slice().reverse()); return h ? [-h[0], -h[1]] : null; };
const edgeHead = edges.map((e) => [headOut(e.nodes), headOut(e.nodes.slice().reverse())]); // [saliendo por a, saliendo por b]
const TURN = -0.3; // coseno mínimo entre el rumbo de llegada y el de salida en una aguja (~107°)
const okTurn = (v, w) => !v || !w || v[0] * w[0] + v[1] * w[1] > TURN;

// camino más corto por las vías desde el nodo i0 hasta cualquiera de los nodos meta ({i, pen}: coste extra por
// quedarse en ese nodo). B = punto de la estación de destino, R = radio de las metas (para la heurística).
// inHead = rumbo con el que el tren llegó a i0 (null = libre). strict = false permite medias vueltas.
function routeTo(i0, goals, pr, B, R, inHead = null, strict = true) {
  const ok = (v, w) => !strict || okTurn(v, w);
  let direct = null;
  for (const g of goals) {
    if (g.i === i0) return { seq: [i0], end: i0 };
    if (!isJ[i0] && !isJ[g.i] && nodeEdge[i0] === nodeEdge[g.i]) {
      const e = edges[nodeEdge[i0]], p0 = e.nodes.indexOf(i0), p1 = e.nodes.indexOf(g.i);
      const seq = p0 <= p1 ? e.nodes.slice(p0, p1 + 1) : e.nodes.slice(p1, p0 + 1).reverse();
      if (!ok(inHead, headOut(seq))) continue;
      const c = Math.abs(nodePos[i0] - nodePos[g.i]) * PROFILES[pr].c[e.cls] * hsF(e.hs, pr) + g.pen;
      if (!direct || c < direct.c) direct = { c, seq, end: g.i };
    }
  }
  // metas por cruce: [coste, fragmento meta→cruce, nodo meta, rumbo al salir del cruce hacia la meta]
  const goalMap = new Map();
  for (const g of goals) for (const [j, c, frag] of exits(g.i, pr)) {
    const arr = goalMap.get(j) || []; arr.push([c + g.pen, frag, g.i, frag.length > 1 ? headOut(frag.slice().reverse()) : null]); goalMap.set(j, arr);
  }
  const hMin = Math.min(...Object.values(PROFILES[pr].c)) * Math.min(1, PROFILES[pr].hs);
  const h = (j) => Math.max(0, dist([nx[jNode[j]], ny[jNode[j]]], B) - R) * hMin;
  // estados: id ≥ 0 → arista ei recorrida hasta su extremo (2·ei + 0: llega a b; 2·ei + 1: llega a a);
  // id < 0 → fragmento inicial desde i0
  const gCost = new Map(), from = new Map(), sJ = new Map(), sHead = new Map(), heap = new Heap();
  const push = (id, j, c, head, fr) => { if (c < (gCost.get(id) ?? Infinity)) { gCost.set(id, c); sJ.set(id, j); sHead.set(id, head); from.set(id, fr); heap.push(c + h(j), id); } };
  if (isJ[i0]) push(-1, jid[i0], 0, inHead, { start: [i0] });
  else {
    exits(i0, pr).forEach(([j, c, frag], q) => { if (ok(inHead, headOut(frag))) push(-2 - q, j, c, headIn(frag), { start: frag }); });
  }
  let best = direct ? { c: direct.c } : null, expanded = 0;
  while (heap.size) {
    const id = heap.pop(); const gc = gCost.get(id), j = sJ.get(id), v = sHead.get(id);
    if (best && gc + h(j) >= best.c) break;
    if (++expanded > 600000) break;
    for (const [gcost, frag, end, w] of goalMap.get(j) || []) if (ok(v, w) && (!best || gc + gcost < best.c)) best = { c: gc + gcost, id, frag, end };
    for (const ei of jAdj[j]) {
      const e = edges[ei]; if (e.a === e.b) continue;
      const fromA = e.a === j, w = edgeHead[ei][fromA ? 0 : 1];
      if (id >= 0 && id >> 1 === ei) continue; // no volver por la misma arista
      if (!ok(v, w)) continue;
      const arrive = fromA ? e.b : e.a, back = edgeHead[ei][fromA ? 1 : 0];
      push(ei * 2 + (fromA ? 0 : 1), arrive, gc + edgeCost(e, pr), back ? [-back[0], -back[1]] : null, { prev: id, e: ei, fromA });
    }
  }
  if (!best) return null;
  if (best.id === undefined) return { seq: direct.seq, end: direct.end };
  // reconstrucción hacia atrás
  const parts = []; let id = best.id;
  for (;;) {
    const fr = from.get(id);
    if (fr.start) { parts.push(fr.start); break; }
    const e = edges[fr.e]; parts.push(fr.fromA ? e.nodes : e.nodes.slice().reverse()); id = fr.prev;
  }
  const seq = [];
  for (let q = parts.length - 1; q >= 0; q--) for (const n of parts[q]) if (seq[seq.length - 1] !== n) seq.push(n);
  for (const n of best.frag.slice().reverse()) if (seq[seq.length - 1] !== n) seq.push(n);
  return { seq, end: best.end };
}
const hasEdge = (i) => (isJ[i] ? jAdj[jid[i]].length > 0 : nodeEdge[i] >= 0);
const nodeFactor = (i, pr) => { const e = isJ[i] ? edges[jAdj[jid[i]][0]] : edges[nodeEdge[i]]; return PROFILES[pr].c[e.cls] * hsF(e.hs, pr); };
// metas de una estación: todos los puntos de vía a menos de (vía más cercana + 150 m), penalizando la distancia
// y las vías que no son del tipo del tren
const goalCache = new Map();
function goalsNear(B, pr) {
  const k = B.join(',') + '|' + pr; if (goalCache.has(k)) return goalCache.get(k);
  const nn = nearNodes(B[0], B[1], 900).filter(([i]) => hasEdge(i));
  let out = { goals: [], R: 0 };
  if (nn.length) {
    const fmin = Math.min(...nn.map(([i]) => nodeFactor(i, pr)));
    // la vía «buena» más cercana manda sobre el radio (en una estación de AVE, la de alta velocidad)
    const d0 = Math.min(...nn.filter(([i]) => nodeFactor(i, pr) <= fmin * 1.01).map(([, d]) => d));
    const R = Math.max(150, d0 + 150);
    const goals = nn.filter(([, d]) => d <= R).slice(0, 500).map(([i, d]) => ({ i, pen: 1.2 * Math.max(0, d - d0) + 300 * (nodeFactor(i, pr) / fmin - 1) }));
    out = { goals, R };
  }
  goalCache.set(k, out); return out;
}
// geometría de un tramo entre paradas (con caché). start = nodo donde acabó el tramo anterior (continuidad)
const pairCache = new Map(); let routed = 0, straight = 0; const fails = [];
function segmentPath(A, B, pr, start, inHead) {
  if (pr !== 'any' && pr !== 'met' && pr !== 'std') {
    const r = segmentPath1(A, B, pr, true, start, inHead);
    if (r) return r;
    return segmentPath1(A, B, 'any', false, start, inHead);
  }
  return segmentPath1(A, B, pr, false, start, inHead);
}
function segmentPath1(A, B, pr, quiet = false, start = null, inHead = null) {
  const i0 = start ?? snap(A[0], A[1], pr);
  const hk = inHead ? Math.round((Math.atan2(inHead[1], inHead[0]) * 180) / Math.PI / 10) : 'x';
  const k = i0 + '>' + B.join(',') + '|' + pr + (quiet ? '?' : '') + '|' + hk;
  if (pairCache.has(k)) return pairCache.get(k);
  let pts = null, why = '', end = null;
  const geo = dist(A, B);
  const { goals, R } = goalsNear(B, pr);
  const ok = (r) => r && r.len < geo * 1.6 + 1500;
  const tryFrom = (s, head, strict = true) => { const r = routeTo(s, goals, pr, B, R, head, strict); if (!r) return null; const p = r.seq.map((n) => [nx[n], ny[n]]); return { p, len: cumDist(p).pop(), end: r.end, seq: r.seq }; };
  if (i0 == null || !goals.length) why = 'sin vía cerca de ' + (i0 == null ? 'origen' : 'destino');
  else {
    // 1) siguiendo el sentido de llegada; 2) libre al salir (estación terminal: el tren invierte la marcha);
    // 3) sin restricciones de giro (mapeo raro de las agujas)
    let best = tryFrom(i0, inHead);
    if (!ok(best) && inHead) {
      const seen = new Set([isJ[i0] ? 'j' + i0 : nodeEdge[i0]]);
      for (const g of goalsNear(A, pr).goals.slice().sort((x, y) => x.pen - y.pen)) {
        const e = isJ[g.i] ? 'j' + g.i : nodeEdge[g.i]; if (seen.has(e)) continue; seen.add(e); if (seen.size > 13) break;
        const r = tryFrom(g.i, inHead); if (r && ok(r) && (!ok(best) || r.len < best.len)) best = r;
      }
    }
    if (!ok(best) && inHead) { const r = tryFrom(i0, null); if (r && (!best || r.len < best.len * 0.8)) best = r; }
    if (!ok(best)) { const r = tryFrom(i0, null, false); if (r && (!best || r.len < best.len * 0.8)) best = r; }
    if (!ok(best)) {
      // vías paralelas sin conexión (p. ej. ancho ibérico y métrico por el mismo valle): otros puntos de salida
      const seen = new Set(), cands = [];
      for (const [i] of nearNodes(A[0], A[1], 700)) { if (!hasEdge(i)) continue; const e = isJ[i] ? 'j' + i : nodeEdge[i]; if (seen.has(e)) continue; seen.add(e); cands.push(i); if (cands.length >= 12) break; }
      for (const a of cands) { const r = tryFrom(a, null) || tryFrom(a, null, false); if (r && (!best || r.len < best.len)) best = r; }
    }
    if (!best) why = 'sin conexión en el grafo';
    else if (best.len < geo * 3 + 3000 || (best.len < geo * 5 && best.len - geo < 12000)) { pts = best.p; end = best.end; pts.head = best.seq.length > 1 ? headIn(best.seq) : inHead; }
    else why = 'ruta demasiado larga ' + Math.round(best.len / 1000) + ' km vs ' + Math.round(geo / 1000) + ' km';
  }
  if (!pts && quiet) { pairCache.set(k, null); return null; }
  if (!pts) fails.push({ A, B, pr, why, geo: Math.round(dist(A, B)) });
  if (pts) { routed++; pts.end = end; } else { straight++; pts = [A, B]; pts.straight = true; }
  pairCache.set(k, pts); return pts;
}

// recorrido completo de una serie de paradas por las vías: devuelve la polilínea, el índice de cada parada
// en ella y si algún tramo ha quedado en línea recta. Cada tramo sale del nodo donde acabó el anterior.
function joinRoute(pts, pr, onFail) {
  const full = [], idxs = []; let bad = false, start = null, head = null;
  for (let i = 1; i < pts.length; i++) {
    const seg = segmentPath(pts[i - 1], pts[i], pr, start, head);
    if (seg.straight) { bad = true; if (onFail) onFail(i); }
    start = seg.straight ? null : seg.end; head = seg.straight ? null : seg.head;
    if (!full.length) { full.push(seg[0]); idxs.push(0); }
    else if (dist(full[full.length - 1], seg[0]) > 0.5) full.push(seg[0]); // salida por otra vía (sin conexión)
    for (let q = 1; q < seg.length; q++) full.push(seg[q]);
    idxs.push(full.length - 1);
  }
  return { full, idxs, bad };
}

// ============================================================================
// Estaciones unificadas
// ============================================================================
const stations = []; // {n, x, y, seg, ops:Set, a, adif:Set, f, r, keys}
const stByKey = new Map();
const stGrid = new Map();
function addToGrid(i) { const s = stations[i]; const k = Math.floor(s.x / CELL) + ':' + Math.floor(s.y / CELL); let c = stGrid.get(k); if (!c) stGrid.set(k, (c = [])); c.push(i); }
function nearStations(x, y, r) {
  const out = []; const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const i of stGrid.get(cx + dx + ':' + (cy + dy)) || []) { const d = dist([x, y], [stations[i].x, stations[i].y]); if (d <= r) out.push([i, d]); }
  return out.sort((a, b) => a[1] - b[1]);
}
function stationFor(op, stopId, name, lon, lat, extra = {}) {
  // Renfe (Cercanías y LD) comparten código Adif → misma estación
  const key = (op === 'CER' || op === 'LD' ? 'ADIF:' : op + ':') + stopId;
  if (stByKey.has(key)) { const i = stByKey.get(key); stations[i].ops.add(op); if (extra.a) stations[i].a = 1; return i; } // p. ej. Cercanías y LD con el mismo código Adif
  let idx;
  if (op === 'OUIGO') { // Ouigo: a la estación Renfe más cercana
    const near = nearStations(lon, lat, 700);
    if (near.length) idx = near[0][0];
  }
  if (idx === undefined) { // misma parada con otro código: a menos de 25 m
    const near = nearStations(lon, lat, 25);
    if (near.length) idx = near[0][0];
  }
  if (idx === undefined) {
    idx = stations.length;
    stations.push({ n: name, x: r5(lon), y: r5(lat), ops: new Set(), a: 0, codes: new Set() });
    addToGrid(idx);
  }
  const s = stations[idx]; s.ops.add(op);
  if (op === 'CER' || op === 'LD') s.codes.add(stopId);
  if (op === 'FGC') s.f = stopId;
  if (extra.a) s.a = 1;
  // nombre más descriptivo (el de LD suele ser el oficial)
  if (op === 'LD' && name && !/tur[íi]stic/i.test(name)) s.n = name;
  else if (/tur[íi]stic/i.test(s.n) && name && !/tur[íi]stic/i.test(name)) s.n = name;
  stByKey.set(key, idx); return idx;
}

// ============================================================================
// Líneas, patrones, servicios
// ============================================================================
const lines = [], lineIdx = new Map();
const shapesOut = [], patterns = [], patIdx = new Map();
const services = [], svcIdx = new Map();
const first = new Date(Date.now() - 86400000); first.setUTCHours(0, 0, 0, 0);
const WINDOW = []; for (let i = 0; i <= DAYS_AHEAD; i++) WINDOW.push(ymdOf(new Date(first.getTime() + i * 86400000)));
const winSet = new Set(WINDOW);
const feeds = [];

// Productos Renfe AV/LD/MD → segmento, perfil de vía, tipo visual
const PRODUCTS = {
  'AVE': { seg: 'EST', pr: 'ave', kind: 'ave', color: '#6B2A8C', label: 'AVE' },
  'AVE INT': { seg: 'EST', pr: 'ave', kind: 'ave', color: '#6B2A8C', label: 'AVE Int.' },
  'AVLO': { seg: 'EST', pr: 'ave', kind: 'avlo', color: '#D6006F', label: 'AVLO' },
  'EUROMED': { seg: 'EST', pr: 'ave', kind: 'ave', color: '#0B6FB8', label: 'Euromed' },
  'ALVIA': { seg: 'EST', pr: 'mix', kind: 'alvia', color: '#8E5CC4', label: 'Alvia' },
  'Intercity': { seg: 'EST', pr: 'mix', kind: 'intercity', color: '#0098D8', label: 'Intercity' },
  'TRENCELTA': { seg: 'EST', pr: 'ib', kind: 'md', color: '#00857C', label: 'Celta' },
  'AVANT': { seg: 'REG', pr: 'ave', kind: 'avant', color: '#A0579F', label: 'Avant' },
  'AVANT EXP': { seg: 'REG', pr: 'ave', kind: 'avant', color: '#A0579F', label: 'Avant Exp' },
  'MD': { seg: 'REG', pr: 'ib', kind: 'md', color: '#EE7F00', label: 'MD' },
  'REGIONAL': { seg: 'REG', pr: 'ib', kind: 'regional', color: '#F2A900', label: 'Regional' },
  'REG.EXP.': { seg: 'REG', pr: 'ib', kind: 'regional', color: '#E28A00', label: 'Reg. Exp.' },
  'PROXIMDAD': { seg: 'REG', pr: 'ib', kind: 'cercanias', color: '#E4002B', label: 'Proximidad' },
};
// Núcleos de Cercanías → comunidad y ancho por defecto
const NUCLEOS = {
  10: ['MAD', 'Madrid'], 20: ['AST', 'Asturias'], 30: ['AND', 'Sevilla'], 31: ['AND', 'Cádiz'], 32: ['AND', 'Málaga'],
  40: ['VAL', 'València'], 41: ['MUR', 'Murcia/Alicante'], 45: ['MUR', 'Cartagena'], 46: ['GAL', 'Ferrol'], 47: ['CYL', 'León'],
  51: ['CAT', 'Rodalies de Catalunya'], 60: ['PVA', 'Bilbao'], 61: ['PVA', 'San Sebastián'], 62: ['CNT', 'Santander'], 70: ['ARA', 'Zaragoza'], 90: ['MAD', 'Cercedilla-Cotos'],
};
const METRIC_NUCLEOS = new Set([45, 46, 47]);

async function processFeed({ op, dir, routeInfo, keyOf }) {
  const agencyTZ = readCsv(path.join(dir, 'agency.txt'))[0] || {};
  const feed = { op, start: null, end: null, built: new Date().toISOString().slice(0, 10) };
  const fi = readCsv(path.join(dir, 'feed_info.txt'))[0]; if (fi) { feed.start = fi.feed_start_date; feed.end = fi.feed_end_date; feed.version = fi.feed_version; }
  // calendario en la ventana
  const svcDates = new Map();
  const WD = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  let calMin = null, calMax = null;
  for (const c of readCsv(path.join(dir, 'calendar.txt'))) {
    const set = new Set();
    if (!calMin || c.start_date < calMin) calMin = c.start_date; if (!calMax || c.end_date > calMax) calMax = c.end_date;
    for (const d of WINDOW) if (d >= c.start_date && d <= c.end_date && c[WD[dateOf(d).getUTCDay()]] === '1') set.add(d);
    svcDates.set(c.service_id, set);
  }
  const cdf = path.join(dir, 'calendar_dates.txt');
  if (fs.existsSync(cdf)) await streamCsv(cdf, (v, ix) => {
    const d = g(v, ix, 'date'); if (!calMax || d > calMax) calMax = d;
    if (!winSet.has(d)) return;
    const sid = g(v, ix, 'service_id'); if (!svcDates.has(sid)) svcDates.set(sid, new Set());
    if (g(v, ix, 'exception_type') === '1') svcDates.get(sid).add(d); else svcDates.get(sid).delete(d);
  });
  feed.start ||= calMin; feed.end ||= calMax;
  // si ningún servicio cae en la ventana (GTFS caducado o futuro), se conservan las últimas 2 semanas del feed
  const activeInWindow = [...svcDates.values()].some((s) => s.size);
  let fallbackDates = null;
  if (!activeInWindow) {
    log(`  ${op}: el GTFS no cubre la ventana; se guardan sus últimos 14 días como horario de referencia`);
    const end = dateOf(calMax); fallbackDates = []; for (let i = 13; i >= 0; i--) fallbackDates.push(ymdOf(new Date(end.getTime() - i * 86400000)));
    const fset = new Set(fallbackDates);
    for (const c of readCsv(path.join(dir, 'calendar.txt'))) { const s = svcDates.get(c.service_id); for (const d of fallbackDates) if (d >= c.start_date && d <= c.end_date && c[WD[dateOf(d).getUTCDay()]] === '1') s.add(d); }
    if (fs.existsSync(cdf)) await streamCsv(cdf, (v, ix) => { const d = g(v, ix, 'date'); if (!fset.has(d)) return; const sid = g(v, ix, 'service_id'); if (!svcDates.has(sid)) svcDates.set(sid, new Set()); if (g(v, ix, 'exception_type') === '1') svcDates.get(sid).add(d); else svcDates.get(sid).delete(d); });
  }
  feeds.push(feed);

  const routes = new Map();
  for (const r of readCsv(path.join(dir, 'routes.txt'))) { const info = routeInfo(r); if (info) routes.set(r.route_id, info); }
  const stopsRaw = new Map(readCsv(path.join(dir, 'stops.txt')).map((s) => [s.stop_id, s]));
  const trips = new Map(); const shapeIds = new Set();
  for (const t of readCsv(path.join(dir, 'trips.txt'))) {
    const info = routes.get(t.route_id); if (!info) continue;
    const ds = svcDates.get(t.service_id); if (!ds || !ds.size) continue;
    trips.set(t.trip_id, { info, svc: t.service_id, head: t.trip_headsign, shape: t.shape_id, short: t.trip_short_name, st: [] });
    if (t.shape_id) shapeIds.add(t.shape_id);
  }
  await streamCsv(path.join(dir, 'stop_times.txt'), (v, ix) => {
    const t = trips.get(g(v, ix, 'trip_id')); if (!t) return;
    t.st.push([+g(v, ix, 'stop_sequence'), g(v, ix, 'stop_id'), toSec(g(v, ix, 'arrival_time')), toSec(g(v, ix, 'departure_time'))]);
  });
  const shapePts = new Map();
  const shf = path.join(dir, 'shapes.txt');
  if (fs.existsSync(shf)) await streamCsv(shf, (v, ix) => {
    const id = g(v, ix, 'shape_id'); if (!shapeIds.has(id)) return;
    if (!shapePts.has(id)) shapePts.set(id, []);
    shapePts.get(id).push([+g(v, ix, 'shape_pt_sequence'), +g(v, ix, 'shape_pt_lon'), +g(v, ix, 'shape_pt_lat')]);
  });
  for (const [id, arr] of shapePts) shapePts.set(id, arr.sort((a, b) => a[0] - b[0]).map((p) => [p[1], p[2]]));

  const shapeCache = new Map();
  let nT = 0;
  for (const [tid, t] of trips) {
    if (t.st.length < 2) continue;
    t.st.sort((a, b) => a[0] - b[0]);
    for (const x of t.st) { if (x[2] == null) x[2] = x[3]; if (x[3] == null) x[3] = x[2]; }
    if (t.st.some((x) => x[2] == null)) continue;
    t.st = t.st.filter((x) => { const s = stopsRaw.get(x[1]); if (!s) return true; const p = (s.parent_station && stopsRaw.get(s.parent_station)) || s; return inSpain(+p.stop_lon, +p.stop_lat, p.stop_name); });
    if (t.st.length < 2) continue;
    const pts = [], st = [];
    let bad = false;
    for (const x of t.st) {
      const s = stopsRaw.get(x[1]); if (!s) { bad = true; break; }
      const parent = s.parent_station ? stopsRaw.get(s.parent_station) : null;
      const base = parent || s;
      pts.push([+s.stop_lon, +s.stop_lat]);
      st.push(stationFor(op, base.stop_id, base.stop_name.replace(/\s+/g, ' '), +base.stop_lon, +base.stop_lat, { a: s.wheelchair_boarding === '1' }));
    }
    if (bad) continue;
    const L = t.info;
    // línea
    let li = lineIdx.get(L.id);
    if (li === undefined) { li = lines.length; lineIdx.set(L.id, li); lines.push({ ...L, st: new Set() }); }
    st.forEach((s) => lines[li].st.add(s));
    // geometría: trazado del GTFS si encaja; si no, por las vías de OSM
    const sk = (t.shape || '') + '|' + L.pr + '|' + pts.map((p) => p.join(',')).join(';');
    let geom = shapeCache.get(sk);
    if (!geom) {
      let shp = null, sd = null;
      if (t.shape && shapePts.has(t.shape)) {
        const simp = simplify(shapePts.get(t.shape), 3).map(([a, b]) => [r5(a), r5(b)]);
        const r = projectSeq(simp, cumDist(simp), pts);
        if (goodFit(r, pts)) { shp = simp; sd = r.sd; }
      }
      // trazado del GTFS aproximado (se sale de las vías): se prefiere el de OSM si sale completo
      let osm = null;
      if (!shp || offTrack(shp)) {
        const { full, idxs, bad } = joinRoute(pts, L.pr, (i) => { if (process.env.DEBUG_SHAPES) log(`  GTFS aproximado y sin ruta OSM: ${L.id} ${stations[st[i - 1]].n} → ${stations[st[i]].n}`); });
        if (!shp || !bad) osm = { full, idxs };
      }
      if (osm) {
        shp = null; const { full, idxs } = osm;
        // simplificar conservando las paradas
        const keep = new Set(idxs); const out = []; const outIdx = [];
        for (let a = 0; a < idxs.length - 1; a++) {
          const part = simplify(full.slice(idxs[a], idxs[a + 1] + 1), 3);
          if (a === 0) { out.push(part[0]); outIdx.push(0); }
          for (let q = 1; q < part.length; q++) out.push(part[q]);
          outIdx.push(out.length - 1);
        }
        shp = out.map(([a, b]) => [r5(a), r5(b)]);
        const cum = cumDist(shp); sd = outIdx.map((i) => Math.round(cum[i]));
        void keep;
      }
      const shIdx = shapesOut.push(shp) - 1;
      geom = { sh: shIdx, sd }; shapeCache.set(sk, geom);
    }
    const b = t.st[0][3];
    const a = t.st.map((x) => x[2] - b), w = t.st.map((x) => x[3] - b);
    // destino: el del GTFS salvo que venga en MAYÚSCULAS (Ouigo) o sea el tipo de servicio («CIVIS» de Cercanías)
    const lastN = stations[st[st.length - 1]].n, hs = (t.head || '').trim();
    const head = !hs ? lastN : /^civis$/i.test(hs) ? lastN + ' (Civis)' : hs === hs.toUpperCase() && /[A-ZÁÉÍÓÚÑ]{3}/.test(hs) ? lastN : hs;
    const pk = [li, geom.sh, head, st.join('.'), a.join('.'), w.join('.')].join('|');
    let pi = patIdx.get(pk);
    if (pi === undefined) { pi = patterns.length; patIdx.set(pk, pi); patterns.push({ l: li, sh: geom.sh, h: head, s: st, a, w, sd: geom.sd }); }
    const skey = op + ':' + t.svc;
    let si = svcIdx.get(skey);
    if (si === undefined) { si = services.length; svcIdx.set(skey, si); services.push({ o: op, t: [], k: [], dates: svcDates.get(t.svc) }); }
    services[si].t.push(pi, b);
    services[si].k.push(keyOf(tid, t));
    nT++;
  }
  log(`  ${op}: ${routes.size} rutas, ${nT} viajes, ${patterns.length} patrones acumulados`);
}

const renfeKey = (tid) => tid.replace(/^\d{4}[A-Z]/, '');
log('Renfe Cercanías / Rodalies…');
await processFeed({
  op: 'CER', dir: path.join(SRC, 'renfe'), keyOf: (tid) => renfeKey(tid),
  routeInfo: (r) => {
    if (r.route_type !== '2') return null; // sin autobuses sustitutorios
    const n = parseInt(r.route_id.slice(0, 2), 10); const nu = NUCLEOS[n]; if (!nu) return null;
    const sn = r.route_short_name;
    return { id: `CER${n}_${sn}`, sn, op: 'CER', prod: n === 51 ? 'Rodalies' : 'Cercanías', kind: 'cercanias', seg: nu[0], nucleo: nu[1],
      color: '#' + (r.route_color || 'E4002B').toUpperCase(), text: '#' + (r.route_text_color || 'FFFFFF').toUpperCase(),
      pr: METRIC_NUCLEOS.has(n) ? 'met' : 'any' };
  },
});
log('Renfe AV / LD / MD…');
await processFeed({
  op: 'LD', dir: path.join(SRC, 'renfe-ld'), keyOf: (tid, t) => String(parseInt(t.short || tid, 10)),
  routeInfo: (r) => {
    const p = PRODUCTS[r.route_short_name]; if (!p) return null;
    return { id: 'LD_' + r.route_id, sn: p.label, op: 'LD', prod: p.label, kind: p.kind, seg: p.seg, color: p.color, text: '#FFFFFF', pr: p.pr };
  },
});
log('Ouigo…');
await processFeed({
  op: 'OUIGO', dir: path.join(SRC, 'ouigo'), keyOf: (tid, t) => String(t.short || tid).replace(/^\D+/, ''),
  routeInfo: (r) => ({ id: 'OUIGO_' + r.route_id, sn: 'OUIGO', op: 'OUIGO', prod: 'Ouigo', kind: 'ouigo', seg: 'EST', color: '#E5007D', text: '#FFFFFF', pr: 'ave' }),
});
// ----------------------------------------------------------------------------
// Iryo: no publica horarios abiertos → horario ESTIMADO (sources/iryo/horario-estimado.json).
// Tiempos entre paradas: los del AVE más rápido que hace el mismo tramo; trazado por las vías (perfil AV).
// ----------------------------------------------------------------------------
log('Iryo (horario estimado)…');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(SRC, 'iryo', 'horario-estimado.json'), 'utf8'));
  for (const [code, e] of Object.entries(cfg.estaciones_extra || {})) if (!stByKey.has('ADIF:' + code)) stationFor('LD', code, e.nombre, e.lon, e.lat);
  const stIdx = (code) => stByKey.get('ADIF:' + code);
  const aveKinds = new Set(['ave', 'avlo']);
  // tiempo mínimo de viaje entre dos estaciones en los AVE/AVLO del horario de Renfe
  function runTime(a, b) {
    let best = Infinity;
    for (const P of patterns) {
      if (!aveKinds.has(lines[P.l].kind)) continue;
      const i = P.s.indexOf(a), j = P.s.indexOf(b);
      if (i < 0 || j <= i) continue;
      // Iryo no hace las paradas intermedias del AVE: se descuenta su tiempo parado y ~2,5 min de frenada/arranque
      let t = P.a[j] - P.w[i];
      for (let k = i + 1; k < j; k++) t -= (P.w[k] - P.a[k]) + 150;
      best = Math.min(best, t);
    }
    if (best < Infinity) {
      // también por composición a través de una estación intermedia (el tramo directo puede venir de AVE más lentos)
      if (!runTime.depth) {
        runTime.depth = 1;
        const mids = new Set();
        for (const P of patterns) { if (!aveKinds.has(lines[P.l].kind)) continue; const i = P.s.indexOf(a), j = P.s.indexOf(b); if (i >= 0 && j > i + 1) for (let k = i + 1; k < j; k++) mids.add(P.s[k]); }
        for (const c of mids) best = Math.min(best, runTime(a, c) + runTime(c, b));
        runTime.depth = 0;
      }
      return best;
    }
    return Math.round((dist([stations[a].x, stations[a].y], [stations[b].x, stations[b].y]) * 1.25) / (210 / 3.6)); // 210 km/h medios
  }
  const toS = (h) => { const [a, b] = h.split(':').map(Number); return a * 3600 + b * 60; };
  const DWELL = 120;
  const feed = { op: 'IRYO', start: WINDOW[0], end: WINDOW[WINDOW.length - 1], built: new Date().toISOString().slice(0, 10), estimated: true };
  feeds.push(feed);
  const svc = { o: 'IRYO', t: [], k: [], dates: new Set(WINDOW) }; services.push(svc);
  let nT = 0;
  for (const R of cfg.rutas) {
    const codes = R.paradas.map((p) => cfg.paradas[p]);
    const st = codes.map(stIdx);
    if (st.some((x) => x === undefined)) { log(`  Iryo ${R.id}: estación no encontrada (${codes.filter((c, i) => st[i] === undefined).join(', ')})`); continue; }
    for (const dir of ['ida', 'vuelta']) {
      const s = dir === 'ida' ? st : st.slice().reverse();
      for (const x of s) stations[x].ops.add('IRYO');
      const li = lines.length;
      const L = { id: `IRYO_${R.id}_${dir}`, sn: 'Iryo', op: 'IRYO', prod: 'Iryo', kind: 'iryo', seg: 'EST', color: '#C8102E', text: '#FFFFFF', pr: 'ave', est: 1, st: new Set(s) };
      lines.push(L); lineIdx.set(L.id, li);
      // horarios relativos (llegada / salida) y geometría por las vías
      const a = [0], w = [0];
      for (let k = 1; k < s.length; k++) { const arr = w[k - 1] + runTime(s[k - 1], s[k]); a.push(arr); w.push(k === s.length - 1 ? arr : arr + DWELL); }
      const pts = s.map((x) => [stations[x].x, stations[x].y]);
      const { full, idxs } = joinRoute(pts, 'ave');
      const out = [], outIdx = [];
      for (let q = 0; q < idxs.length - 1; q++) { const part = simplify(full.slice(idxs[q], idxs[q + 1] + 1), 3); if (q === 0) { out.push(part[0]); outIdx.push(0); } for (let m = 1; m < part.length; m++) out.push(part[m]); outIdx.push(out.length - 1); }
      const shp = out.map(([x, y]) => [r5(x), r5(y)]), cum = cumDist(shp);
      const sh = shapesOut.push(shp) - 1;
      const pi = patterns.push({ l: li, sh, h: stations[s[s.length - 1]].n, s, a, w, sd: outIdx.map((i) => Math.round(cum[i])) }) - 1;
      const starts = (R[`${dir}_salidas`] || []).map(toS).concat((R[`${dir}_llegadas`] || []).map((h) => toS(h) - a[a.length - 1]));
      for (const b of starts) { svc.t.push(pi, b); svc.k.push(`IRYO-${R.id}-${dir}-${Math.floor(b / 60)}`); nT++; }
    }
  }
  log(`  IRYO: ${cfg.rutas.length} rutas, ${nT} viajes estimados por día`);
}

log('FGC…');
const FGC_LINES = { L6: 'std', L7: 'std', L12: 'std', S1: 'std', S2: 'std', L8: 'met', S3: 'met', S4: 'met', S8: 'met', S9: 'met', R5: 'met', R50: 'met', R53: 'met', R6: 'met', R60: 'met', R63: 'met' };
await processFeed({
  op: 'FGC', dir: path.join(SRC, 'fgc'), keyOf: (tid) => tid.split('|').pop(),
  routeInfo: (r) => {
    if (r.route_id !== r.route_short_name || !FGC_LINES[r.route_short_name]) return null;
    return { id: 'FGC_' + r.route_short_name, sn: r.route_short_name, op: 'FGC', prod: 'FGC', kind: 'fgc', seg: 'CAT',
      color: '#' + r.route_color.toUpperCase(), text: '#' + (r.route_text_color || 'FFFFFF').toUpperCase(), pr: FGC_LINES[r.route_short_name] };
  },
});
log(`trazados por las vías: ${routed} tramos, en línea recta (sin vía encontrada): ${straight}`);
{ const by = {}; for (const x of fails) { const k = x.why.replace(/d+ km vs d+ km/, 'N km'); by[k] = (by[k] || 0) + 1; } log('motivos: ' + JSON.stringify(by)); fs.writeFileSync(path.join(ROOT, 'sources', 'fallos-trazado.json'), JSON.stringify(fails.map((x) => ({ ...x, a: nearStations(x.A[0], x.A[1], 50)[0]?.[0], b: nearStations(x.B[0], x.B[1], 50)[0]?.[0] })).map((x) => ({ why: x.why, pr: x.pr, km: x.geo / 1000, de: stations[x.a]?.n, a: stations[x.b]?.n })), null, 1)); }

// ============================================================================
// Segmentos: comunidad de cada estación y de cada línea regional
// ============================================================================
for (const s of stations) s.seg = ccaaOf(s.x, s.y);
for (const L of lines) {
  if (L.seg !== 'REG') continue;
  const cnt = {}; for (const s of L.st) cnt[stations[s].seg] = (cnt[stations[s].seg] || 0) + 1;
  L.seg = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
}
// nombre descriptivo de cada línea: origen – destino del patrón más largo
for (const [li, L] of lines.entries()) {
  const ps = patterns.filter((p) => p.l === li).sort((a, b) => b.s.length - a.s.length);
  const P = ps[0];
  L.from = stations[P.s[0]].n; L.to = stations[P.s[P.s.length - 1]].n;
  L.nst = L.st.size; delete L.st; delete L.pr;
}

// ============================================================================
// Andenes (OSM) junto a nuestras estaciones (solo la forma, sin numeración)
// ============================================================================
const plats = [];
const pj = JSON.parse(fs.readFileSync(path.join(SRC, 'osm', 'andenes.json'), 'utf8'));
for (const w of pj.elements || []) {
  if (!w.geometry || w.geometry.length < 2) continue;
  const pts = w.geometry.filter(Boolean).map((p) => [p.lon, p.lat]);
  const c = pts[Math.floor(pts.length / 2)];
  const near = nearStations(c[0], c[1], 450);
  if (!near.length) continue;
  const closed = pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  const simp = simplify(pts, 0.8).map(([a, b]) => [r5(a), r5(b)]);
  plats.push({ s: near[0][0], c: closed ? 1 : 0, p: enc(simp) });
}
log(`andenes asociados a estaciones: ${plats.length}`);
// vías numeradas de cada estación: se unen los tramos contiguos con el mismo número
const tracks = [];
{
  const bySt = new Map();
  for (const t of numberedTracks) {
    if (t.pts.length < 2) continue;
    const c = t.pts[Math.floor(t.pts.length / 2)], near = nearStations(c[0], c[1], 700);
    if (!near.length) continue;
    const k = near[0][0] + '|' + t.r;
    if (!bySt.has(k)) bySt.set(k, []); bySt.get(k).push(t.pts);
  }
  for (const [k, parts] of bySt) {
    const [si, r] = k.split('|');
    for (const p of parts) tracks.push({ s: +si, r, p: enc(simplify(p, 0.8).map(([a, b]) => [r5(a), r5(b)])) });
  }
  log(`vías numeradas en estaciones: ${tracks.length} tramos en ${new Set(tracks.map((t) => t.s)).size} estaciones`);
}

// ============================================================================
// Salida
// ============================================================================
const days = {};
services.forEach((s, i) => { for (const d of s.dates) (days[d] ||= []).push(i); });
const segs = [{ id: 'EST', name: 'Larga distancia', short: 'Estatal' }, ...ccaa.map((c) => ({ id: c.id, name: c.name, bbox: c.bbox.map((v) => +v.toFixed(3)), poly: c.polys.map((p) => enc(simplify(p[0], 600))) }))];
const network = {
  v: 2, built: new Date().toISOString(), feeds, segs,
  lines,
  stations: stations.map((s) => {
    const o = { n: s.n, x: s.x, y: s.y, seg: s.seg, ops: [...s.ops] };
    if (s.a) o.a = 1; if (s.codes.size) o.c = [...s.codes]; if (s.f) o.f = s.f;
    return o;
  }),
  shapes: shapesOut.map(enc),
  patterns,
};
const schedule = { days, services: services.map((s) => ({ o: s.o, t: s.t, k: s.k })) };
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
const wr = (name, varName, obj) => { const f = path.join(OUT, 'data', name); fs.writeFileSync(f, `window.${varName}=${JSON.stringify(obj)};\n`); return (fs.statSync(f).size / 1048576).toFixed(2) + ' MB'; };
log(`red: ${wr('network.js', 'TD_NET', network)} · horarios: ${wr('schedule.js', 'TD_SCH', schedule)} · andenes: ${wr('platforms.js', 'TD_PLAT', plats)} · vías: ${wr('tracks.js', 'TD_TRACKS', tracks)}`);
log(`${lines.length} líneas, ${stations.length} estaciones, ${patterns.length} patrones, ${services.length} servicios`);
const bySeg = {}; for (const L of lines) bySeg[L.seg] = (bySeg[L.seg] || 0) + 1; log('líneas por segmento: ' + JSON.stringify(bySeg));
