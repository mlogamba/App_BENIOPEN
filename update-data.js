// Descarga clasificaciones y resultados de beniopen.es y los guarda en /data
// Si una descarga falla, se conserva el archivo anterior (nunca se borra nada).
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.beniopen.es';
const GRUPOS = ['a', 'b', 'c', 'd', 'e', 'f'];
const DATA = path.join(__dirname, '..', 'data');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'es-ES,es;q=0.9'
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getHtml(url, tries = 3) {
  let last = 'sin respuesta';
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      const r = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: ctrl.signal });
      clearTimeout(t);
      const txt = await r.text();
      if (r.ok && txt.length > 500) return txt;
      last = 'HTTP ' + r.status;
    } catch (e) { last = String(e && e.message || e); }
    if (i < tries - 1) await sleep(1500 * (i + 1));
  }
  throw new Error(last);
}

function minTables(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  return tables.join('\n')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(\/?)(table|thead|tbody|tfoot|tr|th|td)\b[^>]*>|<[^>]+>/gi, (m, s, t) => t ? '<' + s + t.toLowerCase() + '>' : '')
    .replace(/\s+/g, ' ');
}

const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(parseInt(n, 10)));

function parseResults(html) {
  const matches = [], seen = {};
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = decode(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!text || text.length < 6 || seen[text]) continue;
    const gm = text.match(/\(([A-F])\)\s*$/i);
    if (!gm && !/\d/.test(text)) continue;
    seen[text] = 1;
    matches.push({ raw: text, group: gm ? gm[1].toUpperCase() : 'GENERAL' });
  }
  return matches;
}

// Escribe solo si el contenido cambió (evita commits inútiles)
function saveIfChanged(file, payload, key) {
  const full = path.join(DATA, file);
  try {
    const old = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (JSON.stringify(old[key]) === JSON.stringify(payload[key])) { console.log('= sin cambios', file); return; }
  } catch (e) {}
  fs.writeFileSync(full, JSON.stringify(Object.assign({ updatedAt: new Date().toISOString() }, payload)));
  console.log('✓ actualizado', file);
}

(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  let okCount = 0;

  for (const g of GRUPOS) {
    try {
      const html = minTables(await getHtml(`${BASE}/table/segunda-${g}/`));
      if (!html) throw new Error('sin tablas');
      saveIfChanged(`clas-segunda-${g}.json`, { html }, 'html');
      okCount++;
    } catch (e) { console.warn('✗ clasificación segunda-' + g + ':', e.message); }
  }

  try {
    const matches = parseResults(await getHtml(`${BASE}/ultimos-resultados/ultimos-resultados-segunda/`));
    if (!matches.length) throw new Error('sin resultados');
    saveIfChanged('resultados.json', { matches }, 'matches');
    okCount++;
  } catch (e) { console.warn('✗ resultados:', e.message); }

  if (okCount === 0) { console.error('No se pudo descargar nada.'); process.exit(1); }
})();
