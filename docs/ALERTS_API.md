# TradingView alerts — the private REST API

`src/core/alerts.js` talks to `https://pricealerts.tradingview.com` using the logged-in
session cookie (`credentials: 'include'`) from inside the TradingView page. This is a
**private, undocumented API** — it can change without notice. Everything here was verified
against a live session on 2026-09-02.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | `/list_alerts`    | every alert on the account |
| POST | `/create_alert`   | create (payload not yet captured) |
| POST | `/delete_alerts`  | **destructive, irreversible** |
| POST | `/stop_alerts`    | pause → `active: false` |
| POST | `/restart_alerts` | resume → `active: true` |

Not present: `modify_alerts`, `list_fires`, `get_quota` — these answer `no_such_endpoint`.

**Probing safely.** The API distinguishes a missing route from a bad body, so you can map the
surface without writing anything: a route that does not exist answers
`{"err":{"code":"no_such_endpoint"}}` and names the method (`no such endpoint: GET /foo`),
while a real route with a bad body answers `{"err":{"code":"invalid_request"}}`. Note the
method is part of the identity — `GET /create_alert` is `no_such_endpoint` even though
`POST /create_alert` exists.

## Write payload

```
POST https://pricealerts.tradingview.com/stop_alerts
body: {"payload":{"alert_ids":[5360101711]}}
```

`stop_alerts`, `restart_alerts` and `delete_alerts` all take this identical shape — each
confirmed by intercepting TradingView's own requests, delete included. Only `create_alert`
remains uncaptured.

Two things that cost time to discover:

1. **The body is JSON with a nested `payload` wrapper.** Form-encoded bodies
   (`alert_id=…`, `alert_ids=…`, `ids=…`, `alert_ids=[…]`) are all rejected with
   `invalid_request`. The error never names the missing field, so this cannot be
   reverse-engineered — it has to be observed.
2. **Do not set `Content-Type: application/json`.** That makes it a non-simple CORS request,
   and the preflight fails from this origin. Leaving the header unset gives `text/plain`,
   which is a simple request and succeeds. TradingView's own client does the same.

TradingView also appends `?log_username=…&maintenance_unset_reason=…&build_time=…`. These are
telemetry; the call works without them.

### How to capture a payload you do not have yet

The interceptor below survives until the page reloads. Install it, perform the action once in
TradingView's own alerts panel, then read `window.__alertCap`.

```js
window.__alertCap = [];
const F = window.fetch;
window.fetch = function (input, init) {
  const u = typeof input === 'string' ? input : (input && input.url) || '';
  if (/pricealerts/.test(u)) window.__alertCap.push({ url: u, method: init?.method, body: init?.body });
  return F.apply(this, arguments);
};
```

`create_alert` still needs this treatment. Never brute-force a write endpoint whose success is
destructive — capture it instead.

### Confirm gate

`alert_delete` and `alert_create` do nothing without `confirm: true`; they return
`{ proposed: true, would_delete | would_create }` instead. The gate is at the tool boundary
rather than in a prompt because the analysis agent runs with the whole `mcp__tradingview`
server allowlisted and could otherwise call them directly.

## Reading alerts

`alert_list` summarises by default. The raw rows embed the study's full input set — roughly
200 `in_*` entries per alert — so four alerts come to ~8.9 KB raw versus ~1.8 KB summarised.
Pass `summary: false` only when you genuinely need the inputs.

### Health flags

`annotate()` (pure, unit-tested in `tests/alert_health.test.js`) adds:

| Flag | Meaning |
|---|---|
| `expired` | `expiration` is in the past |
| `expiring_soon` | expires within 7 days |
| `inactive` | `active === false` |
| `never_fired` | the API reports no `last_fire_time` (not proof it never fired) |
| `stale_version` | the alert runs an older script version than the chart has loaded |

**`stale_version` is the one worth caring about.** A TradingView alert executes the script
version it was *created* with. Editing the indicator afterwards does not update existing
alerts, and nothing in TradingView's UI surfaces the drift. On this account both active
alerts were at v28.0 and v21.0 while the chart's script had reached v69.0.

To compare versions you need the right `metaInfo` fields on the chart study:

| Want | Field | Trap |
|---|---|---|
| alert's `pine_id` | `mi.scriptIdPart` → `"USER;<hash>"` | `mi.id` wraps it as `Script$USER;<hash>@tv-scripting` |
| script version | `mi.pine.version` → `"69.0"` | **not `mi.version`** — that is the metainfo schema version (`101`) and compares as newer than every alert |

Compare numerically, not as strings: `"9.0" > "69.0"` lexically, and real data contains both.
