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

async function callAppsScript(env, body) {
  if (!env.APPS_SCRIPT_URL) {
    return { ok: false, layer: 'worker', code: 'NO_SCRIPT_URL',
             error: 'APPS_SCRIPT_URL var is not configured on the Worker' };
  }
  if (!env.APPS_SCRIPT_TOKEN) {
    return { ok: false, layer: 'worker', code: 'NO_SCRIPT_TOKEN',
             error: 'APPS_SCRIPT_TOKEN secret is not configured on the Worker' };
  }

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
    // Almost always means APPS_SCRIPT_URL points at a stale or wrong deployment:
    // Google served an HTML error page instead of the script's JSON.
    return {
      ok: false, layer: 'worker', code: 'NON_JSON_FROM_SCRIPT',
      error: `Apps Script returned ${res.status} but not JSON — check that ` +
             `APPS_SCRIPT_URL is the current deployment and access is "Anyone"`,
      preview: text.slice(0, 200),
    };
  }
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
