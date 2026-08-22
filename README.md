# Wright Flower Company - flower buying system

Replaces paper-based flower buying. Orders are recorded automatically; **buying
stays a human decision.**

## Architecture

```
ticket photo ──> Drive folder ─┐
                               ├──> hourly routine ──> Cloudflare Worker
ticket photo ──> Gmail ────────┘     (connectors,          (auth, layer tagging)
                                      bypass the                  │
                                      network allowlist)          v
                                                            Apps Script
                                                           (runs as sheet owner)
                                                                  │
                                                                  v
                                                        Flower Buying System
                                                            Google Sheet
```

The Worker exists because Apps Script answers a POST with a 302 to a
session-bound URL that ordinary clients cannot follow. Workers' fetch can.

## Contract

POST one request per order. Rows are objects keyed by column name and mapped
against the sheet's live header row, so column order does not matter and an
unknown key is rejected by name.

```json
{"action":"append","requestId":"drive:<fileId>","writes":[
  {"tab":"Events","rows":[{"event_id":"EV-...","type":"..."}]},
  {"tab":"Event_Line_Items","rows":[{...}]}]}
```

Always branch on `ok`, never on the HTTP status - Apps Script can only ever
return 200, and the Worker translates. Errors carry `layer` and `code`.

`requestId` makes retries idempotent via the hidden `_Writes_Log` tab. Derive it
from the **source object** (drive file id, gmail message id), never from the
order, because marking a source processed and writing rows cannot be atomic.

`dryRun: true` validates auth, tabs and columns without writing.
`GET /health` returns live headers plus the deployed script version.
`GET /whoami` reports which Apps Script deployment the Worker points at.

## Layout

| Path | What |
|---|---|
| `apps-script/Code.gs` | the whole Apps Script project; paste over everything |
| `worker/index.js` | Cloudflare Worker |
| `wrangler.toml` | Worker config; secrets are never in here |
| `setup/routine-intake-prompt.md` | the unattended hourly routine |
| `setup/intake-task-prompt.md` | interactive intake with human readback |
| `setup/connectivity-test-prompt.md` | one-shot diagnostic |
| `setup/allowed-domains.txt` | for the cloud environment allowlist |
| `future/service-account/` | Worker that talks to Sheets directly, no Apps Script |

## Configuration

Google - Apps Script > Project Settings > Script Properties:
`SPREADSHEET_ID`, `SHARED_TOKEN`

Cloudflare - Worker > Settings > Variables and Secrets:
`APPS_SCRIPT_URL` (plaintext), `API_TOKEN` (secret), `APPS_SCRIPT_TOKEN` (secret)

`SHARED_TOKEN` and `APPS_SCRIPT_TOKEN` are the same value under two names and
must match. `API_TOKEN` is what callers present and must NOT match it.

## Hard-won notes

- Apps Script web apps serve the **deployed** version. Saving changes nothing.
  Use Manage deployments > edit > New version, which keeps the same URL.
  "New deployment" mints a different URL and strands your fix.
- Ship a `VERSION` marker and return it from the health check, so "is my code
  live?" is answerable instead of inferred from the shape of its errors.
- Cowork cloud sandboxes block outbound curl by org policy. Connector traffic
  (Drive, Gmail) is brokered server-side and is not subject to it.
- Claude Code routines use cloud environments whose domain allowlist you can
  edit yourself, which is why intake runs there rather than in Cowork.
