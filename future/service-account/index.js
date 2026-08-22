import { appendRows, listDropFiles, readDropFile, trashDropFile } from './google.js';

// Distinct messages per failure mode, and 200 on auth failure so the response
// body actually reaches the caller instead of being eaten upstream.
function refuse(reason) {
  return new Response(JSON.stringify({ ok: false, error: reason }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function ok(body) {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function page(title, detail) {
  return new Response(
    `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">` +
    `<body style="font:16px/1.5 system-ui;padding:2rem;max-width:34rem">` +
    `<h1 style="font-size:1.25rem">${title}</h1><p>${detail}</p>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

function checkToken(url, env) {
  const supplied = url.searchParams.get('k');
  if (!supplied) return 'WORKER: no token on request';
  if (supplied !== env.APPEND_TOKEN) return 'WORKER: token present but does not match';
  return null;
}

// One drop file -> one or more appends.
// Shape: { "writes": [ { "tab": "Orders", "rows": [[...], [...]] } ] }
async function applyPayload(env, payload) {
  const writes = payload.writes || [];
  let appended = 0;
  for (const w of writes) {
    if (!w.tab || !Array.isArray(w.rows) || w.rows.length === 0) continue;
    await appendRows(env, w.tab, w.rows);
    appended += w.rows.length;
  }
  return appended;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return ok({ service: 'flowers-sheets', drive: !!env.DRIVE_FOLDER_ID });
    }

    // Short-URL append, for links the buyer clicks during readback.
    //   /append?k=TOKEN&tab=Orders&row=Garden%20Rose|50|Mayesh
    if (url.pathname === '/append') {
      const bad = checkToken(url, env);
      if (bad) return page('Not recorded', bad);

      const tab = url.searchParams.get('tab');
      const row = url.searchParams.get('row');
      if (!tab || !row) return page('Not recorded', 'WORKER: missing tab or row');

      try {
        await appendRows(env, tab, [row.split('|').map((c) => c.trim())]);
        return page('Recorded', `Appended to <b>${tab}</b>: ${row.replace(/\|/g, ' · ')}`);
      } catch (err) {
        return page('Not recorded', `GOOGLE: ${err.message}`);
      }
    }

    // Manual drain, same work the cron does. Useful for testing.
    if (url.pathname === '/drain') {
      const bad = checkToken(url, env);
      if (bad) return refuse(bad);
      return ok(await drain(env));
    }

    return refuse('WORKER: unknown path');
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(drain(env));
  },
};

async function drain(env) {
  const files = await listDropFiles(env);
  const results = [];
  for (const f of files) {
    try {
      const payload = await readDropFile(env, f.id);
      const appended = await applyPayload(env, payload);
      await trashDropFile(env, f.id);
      results.push({ file: f.name, appended });
    } catch (err) {
      // Leave the file in place so the next tick retries it.
      results.push({ file: f.name, error: err.message });
    }
  }
  return { scanned: files.length, results };
}
