# One-shot connectivity test - run on the scheduled-workflow account

Replace <<API_TOKEN>> below with the Cloudflare API_TOKEN value, then paste
everything under the line into a NEW chat on that account. Run it interactively
so you can read the output. Do not schedule it.

---

You are testing whether this environment can write to the Wright Flower Company
Google Sheet through a Cloudflare Worker. Run every step even if an earlier one
fails, then fill in the summary table at the end.

Report only what you actually observe. Do not guess, do not infer a result you
did not see, and do not "fix" anything - this is a diagnostic.

ENDPOINT  https://flower-buying-api.wright-flowers.workers.dev
TOKEN     <<API_TOKEN>>          (send as: Authorization: Bearer <token>)

STEP 1 - environment
State plainly: do you have a shell / Bash tool? List the tools you can use to
make an outbound HTTP request. If you have no shell, say so explicitly.

STEP 2 - can you reach the Worker at all
GET https://flower-buying-api.wright-flowers.workers.dev/whoami
No auth header needed. Expect JSON with deploymentId, hasApiToken, hasScriptToken.
If this fails, quote the EXACT error. An egress proxy blocking the domain and the
site being down look nothing alike - the error text is what tells us which.

STEP 3 - can you reach Google's APIs
Try to reach https://sheets.googleapis.com/$discovery/rest?version=v4
Report the HTTP status, or the exact error if blocked. A 200 here matters even
though we send no credentials - it tells us whether this environment could talk
to the Sheets API directly in a future design.

STEP 4 - authenticated health check
GET https://flower-buying-api.wright-flowers.workers.dev/health
with header: Authorization: Bearer <<API_TOKEN>>
Report the `version` field and every tab name with its headers.

STEP 5 - real write
POST to the endpoint (same Authorization header, Content-Type: application/json)
with exactly this body:

{
  "action": "append",
  "requestId": "CONNECTIVITY-TEST-001",
  "writes": [
    { "tab": "Events", "rows": [{
        "event_id": "EV-TEST-CONNECTIVITY",
        "type": "Test",
        "customer_name": "CONNECTIVITY TEST - safe to delete",
        "event_date": "2026-08-21",
        "needed_by_date": "",
        "lead_time_class": "",
        "status": "Test",
        "notes": "Written by the connectivity test prompt. Delete this row."
    }]}
  ]
}

Expect: {"ok": true, ...} with a `written` array.
Branch on the `ok` field, NOT the HTTP status code.

STEP 6 - idempotency
POST the exact same body a second time. Expect "deduped": true and NO new row.
If a second row appears instead, say so - that is a real bug.

STEP 7 - error handling
POST this deliberately-bad body and report the `code` and `layer` you get back:

{"action":"append","requestId":"CONNECTIVITY-TEST-002",
 "writes":[{"tab":"Events","rows":[{"not_a_real_column":"x"}]}]}

Expect code UNKNOWN_COLUMN from layer apps_script. Nothing should be written.

FINALLY - fill this in and report it:

| Check | Result | Notes / exact error |
|---|---|---|
| Shell available | | |
| Worker /whoami reachable | | |
| sheets.googleapis.com reachable | | |
| /health authenticated | | version + tab count |
| Real write succeeded | | |
| Second write deduped | | |
| Bad column rejected cleanly | | |

Then state in one sentence: can this environment write to the sheet unattended?
