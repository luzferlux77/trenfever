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
  // tranvías (copias diarias de Mobility Database de los GTFS oficiales de cada operador)
  { dir: 'tram-bcn-baix', urls: ['https://files.mobilitydatabase.org/mdb-1003/latest.zip'] },   // TRAM Barcelona: Trambaix
  { dir: 'tram-bcn-besos', urls: ['https://files.mobilitydatabase.org/mdb-1004/latest.zip'] },  // TRAM Barcelona: Trambesòs
  { dir: 'tram-madrid', urls: ['https://files.mobilitydatabase.org/mdb-2802/latest.zip'] },     // Metro Ligero (CRTM)
  { dir: 'tram-valencia', urls: ['https://files.mobilitydatabase.org/mdb-2830/latest.zip'] },   // Metrovalencia (FGV)
  { dir: 'tram-alicante', urls: ['https://files.mobilitydatabase.org/mdb-2829/latest.zip'] },   // TRAM d'Alacant (FGV)
  { dir: 'tram-euskotren', urls: ['https://files.mobilitydatabase.org/mdb-2715/latest.zip'] },  // Euskotren: tranvías de Bilbao y Vitoria
  { dir: 'tram-murcia', urls: ['https://files.mobilitydatabase.org/mdb-2729/latest.zip'] },     // Tranvía de Murcia
  { dir: 'tram-zaragoza', urls: ['https://files.mobilitydatabase.org/mdb-2801/latest.zip'] },   // Tranvía de Zaragoza
  { dir: 'tram-sevilla', urls: ['https://files.mobilitydatabase.org/mdb-2770/latest.zip'] },    // TUSSAM: Metrocentro
  { dir: 'tram-tenerife', urls: ['https://files.mobilitydatabase.org/mdb-788/latest.zip'] },    // Metropolitano de Tenerife
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
