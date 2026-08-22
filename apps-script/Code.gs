/**
 * Wright Flower Company - Flower Buying System write endpoint.
 * Deploy as: Web app * Execute as "Me" * Who has access "Anyone".
 * Called only by the Cloudflare Worker, never directly by a client.
 *
 * REQUIRED - Project Settings > Script Properties (NOT constants in this file):
 *   SPREADSHEET_ID  the id from the sheet URL, between /d/ and /edit
 *   SHARED_TOKEN    any long random string; must match the Worker's APPS_SCRIPT_TOKEN
 *
 * Apps Script web apps cannot set HTTP status codes - every response is 200.
 * That is why the Worker in front of this translates `ok` into a real status.
 * Callers must branch on `ok`, never on the HTTP code.
 */

var VERSION = 'wfc-2026-08-21-b';
var LOG_TAB = '_Writes_Log';

function reply_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, detail) {
  return reply_({ ok: false, layer: 'apps_script', code: code, error: detail });
}

function config_() {
  var p = PropertiesService.getScriptProperties();
  var id = p.getProperty('SPREADSHEET_ID');
  var token = p.getProperty('SHARED_TOKEN');
  if (!id) throw new Error('Script Property SPREADSHEET_ID is not set');
  if (!token) throw new Error('Script Property SHARED_TOKEN is not set');
  return { id: id, token: token };
}

/** "Substitution OK" -> "substitution_ok", so headers can be written for humans. */
function normalize_(s) {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function headersOf_(sheet) {
  var width = sheet.getLastColumn();
  if (width === 0) return [];
  return sheet.getRange(1, 1, 1, width).getValues()[0];
}

function doGet() {
  return reply_({ ok: true, layer: 'apps_script', version: VERSION, hint: 'alive - use POST' });
}

function doPost(e) {
  try {
    var cfg = config_();

    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      return fail_('BAD_JSON', 'request body is not valid JSON');
    }

    if (!body.token || body.token !== cfg.token) {
      return fail_('BAD_TOKEN', 'shared token missing or wrong at the apps script layer');
    }

    var ss;
    try {
      ss = SpreadsheetApp.openById(cfg.id);
    } catch (err) {
      return fail_('BAD_SPREADSHEET_ID',
        'SPREADSHEET_ID is set but Apps Script cannot open it: ' + err.message);
    }

    var action = body.action || 'append';

    // Health check that proves the whole chain, including sheet access.
    if (action === 'ping') {
      var tabs = ss.getSheets().map(function (s) {
        return { tab: s.getName(), rows: s.getLastRow(), headers: headersOf_(s) };
      });
      return reply_({ ok: true, layer: 'apps_script', version: VERSION, action: 'ping',
                      spreadsheet: ss.getName(), tabs: tabs });
    }

    if (action !== 'append') {
      return fail_('BAD_ACTION', 'unknown action: ' + action);
    }

    var writes = body.writes;
    if (!writes || !writes.length) {
      return fail_('NO_WRITES', 'payload contained no writes[]');
    }

    // Idempotency: a retried scheduled run must not duplicate an order.
    if (body.requestId) {
      var seen = alreadyWritten_(ss, body.requestId);
      if (seen) {
        return reply_({ ok: true, layer: 'apps_script', deduped: true,
                        requestId: body.requestId,
                        note: 'this requestId was already written; nothing appended' });
      }
    }

    // Validate everything before writing anything, so a bad tab name in write #4
    // cannot leave writes #1-3 stranded in the sheet.
    var plan = [];
    for (var i = 0; i < writes.length; i++) {
      var w = writes[i];
      var sheet = ss.getSheetByName(w.tab);
      if (!sheet) {
        return fail_('NO_SUCH_TAB', 'tab "' + w.tab + '" not found. Tabs present: ' +
          ss.getSheets().map(function (s) { return s.getName(); }).join(', '));
      }
      if (!w.rows || !w.rows.length) {
        return fail_('EMPTY_ROWS', 'write for tab "' + w.tab + '" had no rows');
      }

      var headers = headersOf_(sheet);
      if (!headers.length) {
        return fail_('NO_HEADERS', 'tab "' + w.tab + '" has no header row in row 1');
      }
      var keyed = headers.map(normalize_);

      var matrix = [];
      for (var r = 0; r < w.rows.length; r++) {
        var src = w.rows[r];
        var unknown = Object.keys(src).filter(function (k) {
          return keyed.indexOf(normalize_(k)) === -1;
        });
        if (unknown.length) {
          return fail_('UNKNOWN_COLUMN',
            'tab "' + w.tab + '" has no column(s): ' + unknown.join(', ') +
            '. Headers are: ' + headers.join(', '));
        }
        var out = [];
        for (var c = 0; c < keyed.length; c++) {
          var v = '';
          for (var k in src) {
            if (normalize_(k) === keyed[c]) { v = src[k]; break; }
          }
          out.push(v === null || v === undefined ? '' : v);
        }
        matrix.push(out);
      }
      plan.push({ sheet: sheet, tab: w.tab, matrix: matrix });
    }

    // Dry run: everything above has already validated auth, the spreadsheet,
    // every tab name and every column name. Stop here without appending.
    if (body.dryRun) {
      return reply_({ ok: true, layer: 'apps_script', version: VERSION, dryRun: true,
        wouldWrite: plan.map(function (s) {
          return { tab: s.tab, rows: s.matrix.length, firstRow: s.sheet.getLastRow() + 1 };
        }) });
    }

    var written = [];
    for (var p = 0; p < plan.length; p++) {
      var step = plan[p];
      var start = step.sheet.getLastRow() + 1;
      step.sheet.getRange(start, 1, step.matrix.length, step.matrix[0].length)
                .setValues(step.matrix);
      written.push({ tab: step.tab, rows: step.matrix.length, firstRow: start });
    }

    if (body.requestId) recordWrite_(ss, body.requestId, written);

    return reply_({ ok: true, layer: 'apps_script', version: VERSION, written: written });

  } catch (err) {
    return fail_('EXCEPTION', String((err && err.message) || err));
  }
}

function logTab_(ss) {
  var t = ss.getSheetByName(LOG_TAB);
  if (!t) {
    t = ss.insertSheet(LOG_TAB);
    t.appendRow(['request_id', 'written_at', 'summary']);
    t.hideSheet();
  }
  return t;
}

function alreadyWritten_(ss, requestId) {
  var t = logTab_(ss);
  if (t.getLastRow() < 2) return false;
  var ids = t.getRange(2, 1, t.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(requestId)) return true;
  }
  return false;
}

function recordWrite_(ss, requestId, written) {
  logTab_(ss).appendRow([requestId, new Date(), JSON.stringify(written)]);
}
