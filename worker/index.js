/**
 * Wright Flower Company — Cloudflare Worker in front of the Apps Script endpoint.
 *
 * It exists for one reason: Apps Script answers a POST with a 302 to a
 * session-bound googleusercontent URL that ordinary clients cannot follow.
 * Workers' fetch follows it correctly, so this is the only practical reader
 * of the script's replies.
 *
 * Secrets (wrangler secret put ...), never in wrangler.toml:
 *   API_TOKEN           what callers send as `Authorization: Bearer ...`
 *   APPS_SCRIPT_TOKEN   must equal the script's SHARED_TOKEN property
 * Vars (wrangler.toml):
 *   APPS_SCRIPT_URL     the /exec URL of the deployment
 *
 * The two tokens are deliberately different values. A caller never learns the
 * script's token, and a leaked caller token cannot be replayed against Google.
 */

const json = (obj, status) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

// Length-independent compare, so timing cannot leak the token.
function tokenMatches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Apps Script is always HTTP 200. Turn its `code` into a status that means something.
function statusFor(payload) {
  if (payload.ok) return 200;
  switch (payload.code) {
    case 'BAD_TOKEN':            return 401;
    case 'BAD_JSON':
    case 'BAD_ACTION':
    case 'NO_WRITES':
    case 'EMPTY_ROWS':
    case 'NO_SUCH_TAB':
    case 'NO_HEADERS':
    case 'UNKNOWN_COLUMN':       return 400;
    case 'BAD_SPREADSHEET_ID':   return 500;
    default:                     return 502;
  }
}

// A request is safe to send twice when the script can recognize the repeat:
// appends carry a requestId and are deduped, pings and dry runs write nothing.
function isIdempotent(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.action === 'ping') return true;
  if (body.dryRun === true) return true;
  return typeof body.requestId === 'string' && body.requestId.length > 0;
}

async function attemptAppsScript(env, body) {
  let res;
  try {
    res = await fetch(env.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, token: env.APPS_SCRIPT_TOKEN }),
      redirect: 'follow',
    });
  } catch (err) {
    return { ok: false, layer: 'worker', code: 'FETCH_FAILED',
             error: `could not reach Apps Script: ${err.message}` };
  }

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Google served HTML instead of the script's JSON. Two very different
    // causes look identical here: a misconfigured APPS_SCRIPT_URL (every call
    // fails), or a transient stumble in the 302 -> googleusercontent hop (the
    // script already ran, and may already have written). `preview` is what
    // tells them apart, so it must reach the caller.
    return {
      ok: false, layer: 'worker', code: 'NON_JSON_FROM_SCRIPT',
      error: `Apps Script returned ${res.status} but not JSON. If this is ` +
             `persistent, check that APPS_SCRIPT_URL is the current ` +
             `deployment and access is "Anyone". If it is intermittent, the ` +
             `script may have run anyway - re-send the same requestId and ` +
             `the reply will say deduped.`,
      preview: text.slice(0, 200),
    };
  }
}

const RETRYABLE = new Set(['NON_JSON_FROM_SCRIPT', 'FETCH_FAILED']);

async function callAppsScript(env, body) {
  if (!env.APPS_SCRIPT_URL) {
    return { ok: false, layer: 'worker', code: 'NO_SCRIPT_URL',
             error: 'APPS_SCRIPT_URL var is not configured on the Worker' };
  }
  if (!env.APPS_SCRIPT_TOKEN) {
    return { ok: false, layer: 'worker', code: 'NO_SCRIPT_TOKEN',
             error: 'APPS_SCRIPT_TOKEN secret is not configured on the Worker' };
  }

  // The transport stumbles occasionally. Absorb that here rather than making
  // every caller reason about whether a half-failed write landed - but only
  // when a repeat is genuinely harmless.
  const attempts = isIdempotent(body) ? 3 : 1;
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await attemptAppsScript(env, body);
    if (last.ok || !RETRYABLE.has(last.code)) return last;
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
  if (attempts > 1) last.retriedTimes = attempts - 1;
  return last;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Which deployment am I actually pointed at? Answers it without leaking secrets.
    if (url.pathname === '/whoami') {
      const u = env.APPS_SCRIPT_URL || '';
      const id = (u.match(/\/s\/([^/]+)\//) || [])[1] || null;
      return json({ ok: true, layer: 'worker', deploymentId: id,
                    hasApiToken: !!env.API_TOKEN,
                    hasScriptToken: !!env.APPS_SCRIPT_TOKEN }, 200);
    }

    const auth = request.headers.get('authorization') || '';
    const supplied = auth.replace(/^Bearer\s+/i, '');
    if (!supplied) {
      return json({ ok: false, layer: 'worker', code: 'NO_AUTH',
                    error: 'missing Authorization: Bearer header (worker layer)' }, 401);
    }
    if (!tokenMatches(supplied, env.API_TOKEN || '')) {
      return json({ ok: false, layer: 'worker', code: 'BAD_AUTH',
                    error: 'bearer token does not match API_TOKEN (worker layer)' }, 401);
    }

    // End-to-end health: proves auth, the deployment, AND that the sheet opens.
    if (url.pathname === '/health') {
      const out = await callAppsScript(env, { action: 'ping' });
      return json(out, statusFor(out));
    }

    if (request.method !== 'POST') {
      return json({ ok: false, layer: 'worker', code: 'METHOD',
                    error: 'use POST, or GET /health' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, layer: 'worker', code: 'BAD_JSON',
                    error: 'request body is not valid JSON (worker layer)' }, 400);
    }

    const out = await callAppsScript(env, body);
    return json(out, statusFor(out));
  },
};
