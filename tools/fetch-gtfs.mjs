// Descarga los GTFS oficiales más recientes (Renfe Cercanías, Renfe AV/LD/MD, FGC) a sources/.
// Si el servidor oficial no responde, usa la copia de Mobility Database. Uso: node tools/fetch-gtfs.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const FEEDS = [
  { dir: 'renfe', urls: ['https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip', 'https://files.mobilitydatabase.org/mdb-2653/latest.zip'] },
  { dir: 'renfe-ld', urls: ['https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip', 'https://files.mobilitydatabase.org/mdb-2620/latest.zip'] },
  { dir: 'fgc', urls: ['https://www.fgc.cat/google/google_transit.zip', 'https://files.mobilitydatabase.org/mdb-1856/latest.zip'] },
];
for (const f of FEEDS) {
  let buf = null, from = '';
  for (const u of f.urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(300000), headers: { 'User-Agent': 'TrenFever/0.1' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      buf = Buffer.from(await r.arrayBuffer()); if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('no es un zip');
      from = u; break;
    } catch (e) { console.log(`  ${f.dir}: ${new URL(u).host} falló (${e.message})`); }
  }
  if (!buf) { console.log(`${f.dir}: SIN DESCARGAR, se conservan los datos anteriores`); continue; }
  const dst = path.join(ROOT, 'sources', f.dir), zip = dst + '.zip';
  fs.writeFileSync(zip, buf);
  fs.rmSync(dst, { recursive: true, force: true }); fs.mkdirSync(dst, { recursive: true });
  execSync(process.platform === 'win32' ? `"C:/Windows/System32/tar.exe" -xf "${zip}" -C "${dst}"` : `unzip -q -o "${zip}" -d "${dst}"`);
  fs.rmSync(zip);
  console.log(`${f.dir}: ${(buf.length / 1048576).toFixed(1)} MB desde ${new URL(from).host}`);
}
