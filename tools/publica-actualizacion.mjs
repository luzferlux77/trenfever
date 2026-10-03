// Publica una actualización de TrenFever en GitHub (luzferlux77/trenfever) para que los móviles se actualicen solos.
//   node tools/publica-actualizacion.mjs [--apk] [--nota "texto"] [--min-native N] [--web-dir carpeta] [--si-cambia]
// Pasos: escribe <web>/data/version.js (versión AAAA.MM.DD.HHMM, hora de Madrid), empaqueta la carpeta web en un zip,
// crea una release con el zip (y el APK firmado si se pasa --apk o si hay uno más nuevo que el publicado) y actualiza
// manifest.json del repo. --si-cambia: no publica si los datos (red y horarios) son idénticos a los ya publicados.
// Funciona en este PC y en GitHub Actions (allí no hay APK: se conserva el publicado).
// La app lee https://raw.githubusercontent.com/luzferlux77/trenfever/main/manifest.json:
//   { web: { version, url, sha256, minNative, note, data }, apk: { code, name, url } }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'luzferlux77/trenfever';
const GH = fs.existsSync('C:/Program Files/GitHub CLI/gh.exe') ? 'C:/Program Files/GitHub CLI/gh.exe' : 'gh';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const gh = (args, input) => execFileSync(GH, args, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
const log = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);
const WEB = path.resolve(arg('--web-dir') || path.join(ROOT, 'web'));

// --- manifiesto actual (si existe)
let manifest = {}, sha = null;
try { const r = JSON.parse(gh(['api', `repos/${REPO}/contents/manifest.json`])); sha = r.sha; manifest = JSON.parse(Buffer.from(r.content, 'base64').toString('utf8')); } catch { /* primera publicación */ }

// --- huella de los datos: si no han cambiado y se pidió --si-cambia, no hay nada que publicar
const dataHash = crypto.createHash('sha256');
for (const f of ['network.js', 'schedule.js', 'platforms.js', 'tracks.js', 'vias.js']) { const p = path.join(WEB, 'data', f); if (fs.existsSync(p)) dataHash.update(fs.readFileSync(p, 'utf8').replace(/"built":"[^"]*"/g, '')); } // sin las fechas de generación
const data = dataHash.digest('hex').slice(0, 16);
if (process.argv.includes('--si-cambia') && manifest.web?.data === data) { log('los datos no han cambiado: no se publica nada'); process.exit(0); }

// --- versión del paquete web (hora de Madrid, igual en este PC y en GitHub Actions)
const d = new Date();
const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((p) => [p.type, p.value]));
const version = `${parts.year}.${parts.month}.${parts.day}.${parts.hour}${parts.minute}`;
fs.writeFileSync(path.join(WEB, 'data', 'version.js'), `window.TD_VERSION = ${JSON.stringify({ web: version, built: d.toISOString() })};\n`);

// --- APK nativo (solo en este PC): código y nombre de android/app/build.gradle
const gf = path.join(ROOT, 'android', 'app', 'build.gradle');
const g = fs.existsSync(gf) ? fs.readFileSync(gf, 'utf8') : '';
const apkCode = Number((/versionCode\s+(\d+)/.exec(g) || [])[1] || manifest.apk?.code || 0), apkName = (/versionName\s+"([^"]+)"/.exec(g) || [])[1] || manifest.apk?.name;
const apkFile = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const withApk = !!g && (process.argv.includes('--apk') || !manifest.apk || manifest.apk.code < apkCode) && fs.existsSync(apkFile);
// un paquete web solo puede ir a APKs que tengan lo nativo que necesita
const minNative = Number(arg('--min-native') || manifest.web?.minNative || Math.min(apkCode || 5, 5));

// --- zip del paquete web (index.html en la raíz, rutas sin «./»: el actualizador del móvil rechaza esas entradas)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-upd-'));
const zip = path.join(tmp, `trenfever-web-${version}.zip`);
const entries = fs.readdirSync(WEB);
if (process.platform === 'win32') execFileSync('C:/Windows/System32/tar.exe', ['-a', '-c', '-f', zip, '-C', WEB, ...entries]);
else execFileSync('zip', ['-r', '-q', '-X', zip, ...entries], { cwd: WEB });
log(`paquete web ${version}: ${(fs.statSync(zip).size / 1048576).toFixed(1)} MB`);

// --- release
const tag = 'v' + version.replace(/\./g, '-');
const files = [zip];
let apkAsset = null;
if (withApk) { apkAsset = path.join(tmp, `TrenFever-${apkName}.apk`); fs.copyFileSync(apkFile, apkAsset); files.push(apkAsset); }
const note = arg('--nota') || 'Horarios, líneas y trazados actualizados';
gh(['release', 'create', tag, ...files, '--repo', REPO, '--title', `TrenFever · ${version}${withApk ? ' · APK ' + apkName : ''}`, '--notes', note + (withApk ? `\n\nAPK ${apkName} para Android: descárgalo e instálalo encima de la versión anterior.` : '')]);
const base = `https://github.com/${REPO}/releases/download/${tag}/`;
log(`release ${tag} publicada${withApk ? ' con APK ' + apkName : ''}`);

// --- manifiesto
// huella SHA-256 del zip: el móvil la exige para dar por buena la descarga
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
manifest.web = { version, url: base + path.basename(zip), sha256, minNative, note, data, built: d.toISOString() };
if (withApk) manifest.apk = { code: apkCode, name: apkName, url: base + path.basename(apkAsset) };
const body = { message: `actualización ${version}`, content: Buffer.from(JSON.stringify(manifest, null, 2) + '\n').toString('base64') };
if (sha) body.sha = sha;
gh(['api', '-X', 'PUT', `repos/${REPO}/contents/manifest.json`, '--input', '-'], JSON.stringify(body));
log('manifest.json actualizado');

// --- limpieza: se conservan las 6 últimas releases de datos (las que llevan APK se conservan siempre)
try {
  const rel = JSON.parse(gh(['release', 'list', '--repo', REPO, '--limit', '100', '--json', 'tagName,name,createdAt']));
  const old = rel.filter((r) => !/APK/.test(r.name)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(6);
  for (const r of old) { gh(['release', 'delete', r.tagName, '--repo', REPO, '--yes', '--cleanup-tag']); log('borrada release antigua ' + r.tagName); }
} catch (e) { log('limpieza: ' + e.message.split('\n')[0]); }
fs.rmSync(tmp, { recursive: true, force: true });
