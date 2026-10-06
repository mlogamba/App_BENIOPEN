var STORAGE_KEY = 'beniopen_data';

var ICON_192_URL =
  'https://drive.google.com/thumbnail?id=1G3j7h3x6AFZzIcQYbRYJhkX-zn0VYURm&sz=w192#.png';

var ICON_512_URL =
  'https://drive.google.com/thumbnail?id=1G3j7h3x6AFZzIcQYbRYJhkX-zn0VYURm&sz=w512#.png';

function doGet(e) {
  var params = e && e.parameter ? e.parameter : {};
  var appUrl = ScriptApp.getService().getUrl();

  // ---- API JSON para la app alojada en GitHub Pages (CORS abierto en GET) ----
  if (params.api) {
    var out;
    try {
      if (params.api === 'clas') out = leggiClasificacionBeniopen(params.slug, params.force === '1');
      else if (params.api === 'res') out = leggiRisultatiBeniopen(params.force === '1');
      else out = { success: false, error: 'api desconocida' };
    } catch (err) {
      out = { success: false, error: String(err) };
    }
    return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
  }

  if (params.manifest === '1') {
    return ContentService
      .createTextOutput(getManifestJson_())
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (params.sw === '1') {
    return ContentService
      .createTextOutput(getServiceWorkerJs_())
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  var tpl = HtmlService.createTemplateFromFile('Index');

  tpl.manifestUrl = appUrl + '?manifest=1';
  tpl.swUrl = appUrl + '?sw=1';
  tpl.icon192 = ICON_192_URL;
  tpl.icon512 = ICON_512_URL;

  return tpl.evaluate()
    .setTitle('37º Beniopen')
    .setFaviconUrl(ICON_512_URL)
    .addMetaTag(
      'viewport',
      'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover'
    )
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getManifestJson_() {
  var url = ScriptApp.getService().getUrl();

  return JSON.stringify({
    id: url,
    name: '37º Beniopen',
    short_name: 'Beniopen',
    description: 'Gestión de la liguilla 37º Beniopen - Segunda B',
    start_url: url,
    scope: url,
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0f5a4d',
    theme_color: '#0f5a4d',
    icons: [
      {
        src: ICON_192_URL,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable'
      },
      {
        src: ICON_512_URL,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable'
      }
    ]
  });
}

function getServiceWorkerJs_() {
  return [
    "const CACHE_NAME = 'beniopen-v1';",

    "self.addEventListener('install', function(event) {",
    "  self.skipWaiting();",
    "});",

    "self.addEventListener('activate', function(event) {",
    "  event.waitUntil(self.clients.claim());",
    "});",

    "self.addEventListener('fetch', function(event) {",
    "  if (event.request.method !== 'GET') return;",
    "  event.respondWith(fetch(event.request));",
    "});"
  ].join('\n');
}

function salvaDatiNelFoglio(jsonString) {
  var lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);

    PropertiesService
      .getScriptProperties()
      .setProperty(STORAGE_KEY, jsonString);

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: String(err)
    };
  } finally {
    try {
      lock.releaseLock();
    } catch (e) {}
  }
}

function leggiDatiCloud() {
  var jsonString = PropertiesService
    .getScriptProperties()
    .getProperty(STORAGE_KEY);

  var result = {};

  if (jsonString) {
    result[STORAGE_KEY] = jsonString;
  }

  return result;
}

function resetDatiCloud() {
  PropertiesService
    .getScriptProperties()
    .deleteProperty(STORAGE_KEY);
}

/* =====================================================================
 *  LETTURA DATI DA beniopen.es  (versione stabile)
 *  - riprova automaticamente se la web fallisce (3 tentativi)
 *  - cache "fresca" 2 min + copia "di riserva" 6 h (se la web è giù si
 *    restituisce l'ultima copia buona invece di un errore)
 *  - HTML delle tabelle ridotto al minimo, così entra sempre in cache
 * ===================================================================== */
var BASE_URL_ = 'https://www.beniopen.es';
var FRESH_SEC_ = 120;
var STALE_SEC_ = 21600; // massimo consentito da CacheService (6 h)
var GRUPOS_ = ['segunda-a', 'segunda-b', 'segunda-c', 'segunda-d', 'segunda-e', 'segunda-f'];

function fetchHtmlRetry_(url, tries) {
  var lastErr = 'sin respuesta';
  for (var i = 0; i < tries; i++) {
    try {
      var r = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'es-ES,es;q=0.9'
        }
      });
      var code = r.getResponseCode();
      var txt = r.getContentText();
      if (code === 200 && txt && txt.length > 500) return txt;
      lastErr = 'HTTP ' + code;
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e);
    }
    if (i < tries - 1) Utilities.sleep(700 * (i + 1));
  }
  throw new Error('beniopen.es no responde (' + lastErr + ')');
}

function cachePutSafe_(cache, key, obj, sec) {
  try {
    var s = JSON.stringify(obj);
    if (Utilities.newBlob(s).getBytes().length < 95000) cache.put(key, s, sec);
  } catch (e) {}
}

/* Devuelve datos frescos de caché, si no los descarga, y si falla usa la copia de reserva */
function getWithCache_(key, builder, forceRefresh) {
  var cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    var f = cache.get('f_' + key);
    if (f) {
      try { var o = JSON.parse(f); o.success = true; o.fromCache = true; return o; } catch (e) {}
    }
  }
  try {
    var data = builder();
    data.success = true;
    data.cachedAt = Date.now();
    cachePutSafe_(cache, 'f_' + key, data, FRESH_SEC_);
    cachePutSafe_(cache, 's_' + key, data, STALE_SEC_);
    return data;
  } catch (err) {
    var s = cache.get('s_' + key);
    if (s) {
      try { var so = JSON.parse(s); so.success = true; so.stale = true; return so; } catch (e2) {}
    }
    return { success: false, error: String(err && err.message ? err.message : err) };
  }
}

function minTables_(html) {
  var tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  return tables.join('\n')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(\/?)(table|thead|tbody|tfoot|tr|th|td)\b[^>]*>|<[^>]+>/gi, function (m, s, t) {
      return t ? '<' + s + t.toLowerCase() + '>' : '';
    })
    .replace(/\s+/g, ' ');
}

function decodeEntities_(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(parseInt(n, 10)); });
}

/** Resultados en tiempo real, con grupo (A-F) detectado */
function leggiRisultatiBeniopen(forceRefresh) {
  return getWithCache_('resultados', function () {
    var html = fetchHtmlRetry_(BASE_URL_ + '/ultimos-resultados/ultimos-resultados-segunda/', 3);
    var matches = [], seen = {}, m, re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    while ((m = re.exec(html)) !== null) {
      var text = decodeEntities_(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      if (!text || text.length < 6 || seen[text]) continue;
      var gm = text.match(/\(([A-F])\)\s*$/i);
      if (!gm && !/\d/.test(text)) continue; // descarta items de menú sin resultado
      seen[text] = 1;
      matches.push({ raw: text, group: gm ? gm[1].toUpperCase() : 'GENERAL' });
    }
    if (!matches.length) throw new Error('No se encontraron resultados en la página');
    return {
      matches: matches,
      total: matches.length,
      timestamp: Utilities.formatDate(new Date(), 'Europe/Madrid', 'HH:mm')
    };
  }, forceRefresh === true);
}

/** Clasificación de un grupo: devuelve solo las tablas (HTML mínimo); el parsing lo hace la app */
function leggiClasificacionBeniopen(grupoSlug, forceRefresh) {
  var slug = String(grupoSlug || 'segunda-b').toLowerCase();
  if (!/^segunda-[a-f]$/.test(slug)) return { success: false, error: 'Grupo no válido.' };
  return getWithCache_('clas_' + slug, function () {
    var html = fetchHtmlRetry_(BASE_URL_ + '/table/' + slug + '/', 3);
    var out = minTables_(html);
    if (!out) throw new Error('No se encontró ninguna tabla en la página');
    return { html: out };
  }, forceRefresh === true);
}

/** Mantiene la caché siempre caliente (ejecutar por trigger cada 5 min) */
function precalentarCache() {
  try { leggiRisultatiBeniopen(true); } catch (e) {}
  GRUPOS_.forEach(function (s) {
    try { leggiClasificacionBeniopen(s, true); } catch (e) {}
  });
}

/** Ejecutar UNA sola vez a mano desde el editor para crear el trigger */
function instalarTriggerCache() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'precalentarCache') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('precalentarCache').timeBased().everyMinutes(5).create();
  precalentarCache();
}

function creaEventoCalendario(dati) {
  try {
    if (!dati || !dati.date) {
      return {
        success: false,
        error: 'Data mancante.'
      };
    }

    var start = new Date(
      dati.date + 'T' + (dati.time || '18:00') + ':00'
    );

    if (isNaN(start.getTime())) {
      return {
        success: false,
        error: 'Data od ora non valide.'
      };
    }

    var end = new Date(start.getTime() + 90 * 60 * 1000);

    var title =
      '🎾 37º Beniopen: Marcello vs ' + (dati.opp || '');

    var description =
      '37º Beniopen (Segunda B) - Jornada ' + (dati.n || '') + '\n' +
      'Rival: ' + (dati.opp || '') +
      (dati.notes ? '\nNotas: ' + dati.notes : '');

    var calendar = CalendarApp.getDefaultCalendar();
    var event = null;

    if (dati.eventId) {
      try {
        event = calendar.getEventById(dati.eventId);
      } catch (e) {
        event = null;
      }
    }

    if (event) {
      event.setTitle(title);
      event.setTime(start, end);
      event.setLocation(dati.campo || '');
      event.setDescription(description);

      if (dati.email) {
        var guests = event.getGuestList().map(function(guest) {
          return guest.getEmail();
        });

        var alreadyGuest =
          guests.indexOf(dati.email) !== -1;

        if (dati.invita && !alreadyGuest) {
          event.addGuest(dati.email);
        }

        if (!dati.invita && alreadyGuest) {
          event.removeGuest(dati.email);
        }
      }

      return {
        success: true,
        eventId: event.getId(),
        updated: true
      };
    }

    var options = {
      location: dati.campo || '',
      description: description
    };

    if (dati.invita && dati.email) {
      options.guests = dati.email;
      options.sendInvites = true;
    }

    var newEvent = calendar.createEvent(
      title,
      start,
      end,
      options
    );

    return {
      success: true,
      eventId: newEvent.getId(),
      updated: false
    };
  } catch (err) {
    return {
      success: false,
      error: String(err)
    };
  }
}

function eliminaEventoCalendario(eventId) {
  try {
    if (!eventId) {
      return { success: true };
    }

    var calendar = CalendarApp.getDefaultCalendar();
    var event = calendar.getEventById(eventId);

    if (event) {
      event.deleteEvent();
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: String(err)
    };
  }
}
function testGruppi() {
  GRUPOS_.forEach(function (slug) {
    var r = leggiClasificacionBeniopen(slug, true);
    Logger.log(slug + ' -> ok=' + r.success + (r.success ? ' | caracteres=' + r.html.length : ' | ' + r.error));
  });
  var q = leggiRisultatiBeniopen(true);
  Logger.log('resultados -> ok=' + q.success + (q.success ? ' | partidos=' + q.total : ' | ' + q.error));
}