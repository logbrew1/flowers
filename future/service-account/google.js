// Google service-account auth + Sheets/Drive REST calls, no dependencies.
// Workers' Web Crypto can sign RS256, which is all the OAuth2 JWT flow needs.

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
].join(' ');

let cachedToken = null; // { token, expiresAt } — per-isolate, good enough

function b64url(input) {
  const bytes = typeof input === 'string'
    ? new TextEncoder().encode(input)
    : new Uint8Array(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToPkcs8(pem) {
  const b64 = pem
    .replace(/\\n/g, '\n')            // survives being pasted as a one-line secret
    .replace(/-----[A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

export async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.token;

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope: SCOPES,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(env.GOOGLE_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${claim}`),
  );
  const jwt = `${header}.${claim}.${b64url(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: now + data.expires_in };
  return cachedToken.token;
}

async function gapi(env, url, init = {}) {
  const token = await getAccessToken(env);
  const res = await fetch(url, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${url} -> ${res.status} ${await res.text()}`);
  return res;
}

// Append rows to a tab. `rows` is an array of arrays.
export async function appendRows(env, tab, rows) {
  const range = encodeURIComponent(`${tab}!A1`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}`
    + `/values/${range}:append?valueInputOption=USER_ENTERED`
    + `&insertDataOption=INSERT_ROWS`;
  const res = await gapi(env, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: rows }),
  });
  return res.json();
}

export async function listDropFiles(env) {
  const q = encodeURIComponent(`'${env.DRIVE_FOLDER_ID}' in parents and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files`
    + `?q=${q}&fields=files(id,name,createdTime)&orderBy=createdTime&pageSize=50`;
  const { files } = await (await gapi(env, url)).json();
  return files || [];
}

export async function readDropFile(env, fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  return (await gapi(env, url)).json();
}

export async function trashDropFile(env, fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}`;
  await gapi(env, url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}
