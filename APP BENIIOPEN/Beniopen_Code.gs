var STORAGE_KEY = 'beniopen_data';

var ICON_192_URL =
  'https://drive.google.com/thumbnail?id=1G3j7h3x6AFZzIcQYbRYJhkX-zn0VYURm&sz=w192#.png';

var ICON_512_URL =
  'https://drive.google.com/thumbnail?id=1G3j7h3x6AFZzIcQYbRYJhkX-zn0VYURm&sz=w512#.png';

function doGet(e) {
  var params = e && e.parameter ? e.parameter : {};
  var appUrl = ScriptApp.getService().getUrl();

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

/**
 * Legge i risultati in tempo reale dal sito ufficiale Beniopen
 * e li suddivide/filtra per girone (Segunda A, B, C, D, E, F).
 */
function leggiRisultatiBeniopen() {
  try {
    var response = UrlFetchApp.fetch('https://www.beniopen.es/ultimos-resultados/ultimos-resultados-segunda/', {
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });
    var html = response.getContentText();
    var matches = [];
    var liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    var match;
    
    while ((match = liRegex.exec(html)) !== null) {
      var text = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (text && text.length > 5) {
        var groupMatch = text.match(/\(([A-F])\)$/i);
        var group = groupMatch ? groupMatch[1].toUpperCase() : 'GENERAL';
        matches.push({
          raw: text,
          group: group
        });
      }
    }
    
    return {
      success: true,
      matches: matches,
      total: matches.length,
      timestamp: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    };
  } catch (err) {
    return {
      success: false,
      error: String(err)
    };
  }
}

/**
 * Legge la classifica in tempo reale per un girone specifico (es. 'segunda-b', 'segunda-a', ecc.)
 * Ora scarica solo le tabelle e le restituisce come HTML; il parsing lo fa l'app.
 */
function leggiClasificacionBeniopen(grupoSlug) {
  try {
    var slug = String(grupoSlug || 'segunda-b').toLowerCase();
    if (!/^segunda-[a-f]$/.test(slug)) {
      return { success: false, error: 'Grupo no válido.' };
    }

    var cache = CacheService.getScriptCache();
    var key = 'clas_' + slug;
    var cached = cache.get(key);
    if (cached) {
      return { success: true, html: cached, fromCache: true };
    }

    var response = UrlFetchApp.fetch('https://www.beniopen.es/table/' + slug + '/', {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });

    var code = response.getResponseCode();
    if (code !== 200) {
      return { success: false, error: 'La web respondió HTTP ' + code };
    }

    var tables = response.getContentText().match(/<table[\s\S]*?<\/table>/gi) || [];
    var out = tables.join('\n');
    if (!out) {
      return { success: false, error: 'No se encontró ninguna tabla en la página.' };
    }

    if (out.length < 90000) cache.put(key, out, 60);
    return { success: true, html: out };
  } catch (err) {
    return { success: false, error: String(err) };
  }
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
  ['segunda-a','segunda-e','segunda-f','segunda-b'].forEach(function(slug){
    var r = UrlFetchApp.fetch('https://www.beniopen.es/table/' + slug + '/', {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    var html = r.getContentText();
    var tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
    var joined = tables.join('\n');
    Logger.log(slug + ' → HTTP ' + r.getResponseCode() +
      ' | tabelle: ' + tables.length +
      ' | caratteri: ' + joined.length +
      ' | byte: ' + Utilities.newBlob(joined).getBytes().length);
  });
}