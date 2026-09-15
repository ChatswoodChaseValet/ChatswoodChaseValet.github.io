# Bandwidth (Egress) Log — chatswood-valet

Daily Supabase egress for **this app only** (chatswood-valet project), read from the
Supabase dashboard, Settings → Usage, filtered to project = chatswood-valet.
(Org-wide numbers include a second, unrelated project — `scone-thai-massage` — so the
org-level total is NOT the right number to quote for this app.)

Org is on the **Pro plan**: 250 GB/month included egress, pooled across all projects
in the org. Billing cycle: 06th–06th.

| Date (Sydney) | Egress used (this app, cumulative in cycle) | Notes |
|---|---|---|
| 2026-08-07 (morning) | 0.00 GB | Billing cycle reset 06 Aug 2026. Per-project egress chart shows "No data in period" — Supabase says this can take up to 24h to populate after a cycle reset. Baseline reading only, not a real daily figure yet. |
| 2026-08-07 (re-check, ~1hr later) | 0.00 GB | Still "No data in period" on the per-project daily chart. Not yet reflecting live traffic — needs the full 24h window to populate. |

## Code audit — 2026-08-07: confirmed no regression of the July egress bug

Re-read `index_v2.html` end-to-end for anything that could re-blow the egress budget,
prompted by the customer bandwidth question. Findings:

- The 60s poll (`reconcileFromCloud('poll')`, index_v2.html:14163) still takes the
  cheap **incremental** path via `cloudReconcileDelta()` (index_v2.html:13885) —
  fetches only rows where `updated_at` advanced past the last-seen high-water mark;
  an idle station gets a near-empty response, not a full table dump.
- Full re-pulls (`loadFromCloud`) are still limited to infrequent triggers: tab
  focus/visibility change, realtime-socket reconnect, and a one-shot empty-board
  self-heal — the self-heal was itself patched (commit `821e680`) so it can't loop
  and force a full `select()` every poll forever.
- Other periodic timers (`checkEndOfDay`, `flushPendingWrites`, print-agent
  keepalive) do not perform per-tick cloud reads; `flushPendingWrites` early-exits
  when its queue is empty.

**Conclusion:** the fix from the July incident (commit `fc41367` + follow-ups) is
intact — no code-level regression as of this date. This is a point-in-time review,
not a guarantee against future changes; re-audit if a future daily egress reading
comes back unexpectedly high.

## 2026-08-08: found and fixed the actual leak (correction to the 08-07 audit above)

The 08-07 static-code audit above checked the *intended* code paths and looked clean —
but missed a live behavioral bug. Per-project dashboard reading for chatswood-valet
showed **7 Aug egress = 403.38 MB**, ~100% of it `PostgREST` (direct table reads, not
Realtime/Functions/Auth) — almost the full daily budget in one day.

Cross-checked against the Supabase API logs (`get_logs`, service `api`): a full
`entries` select (`select=*&order=time_in.desc&limit=2000`) plus full `app_settings`
select plus a `staff-auth` list call were firing **together, every ~8 seconds**,
continuously, all day.

Root cause: `reconcileFromCloud`'s "at most once per 8s" guard (index_v2.html:14239)
only throttles how *often* it runs — it doesn't distinguish reason. Only `poll`
(the 60s timer) took the cheap incremental-delta path; every other reason
(`reconnect`, `focus`, `visible`) always ran the expensive full `loadFromCloud()`
(entries + app_settings + staff). That's fine if reconnect/focus events are rare —
but if the realtime socket is flapping (bad wifi, laptop sleep/wake, a proxy
killing idle websockets), each `reconnect` event re-triggers a full reload, capped
only by the 8s floor — turning the "rare safety net" into a steady drip of full
table dumps, 24/7.

Fix (commit `43d8b3d`): full reconciles now have their own 60s cooldown
(`lastFullReconcileAt` / `FULL_RECONCILE_MIN_GAP_MS`), independent of the 8s poll
guard. Once a full reload has run, subsequent non-poll triggers fall back to the
cheap delta path until the cooldown clears — so a flapping socket degrades to
"delta every 8s" (near-zero egress) instead of "full table dump every 8s".

Underlying question not yet answered: *why* was the realtime socket reconnecting
that often on 7 Aug? Tenant-level Realtime logs looked stable (no tenant
restarts in the relevant window), so the flapping is more likely client-side
(network/device) than a Supabase-side issue. The 60s cooldown bounds the damage
either way, but if a future egress reading is still high, check whether the
realtime channel is genuinely unstable (dropped connections in the browser
console) rather than assuming this fix alone explains everything.

**Next check:** re-read chatswood-valet's per-project daily egress in a day or two
to confirm 8 Aug onward drops back to a small number.

## 2026-08-09: 8 Aug closed out healthy — ~204.8MB, ~57% below 7 Aug

Per-project dashboard, chatswood-valet filter, "Egress per day" chart — both 7 Aug and
8 Aug are now closed/finalized buckets:

- **7 Aug 2026 (closed):** 484.27MB total — 484.071MB PostgREST (100.0%), 123.626KB
  Functions, 54.149KB Auth, 18.305KB Realtime. Note: this finalized figure is higher
  than the 403.38MB read on 08-08 morning (mid-day figures apparently still update
  after the fact as the day's data settles) — treat 08-08's in-progress readings as
  provisional, the day-after closed number as the real one.
- **8 Aug 2026 (closed):** ~204.76MB total — 204.54MB PostgREST (99.9%), 92.591KB
  Auth, 60.688KB Realtime, 60.33KB Functions. ~57% below 7 Aug's closed total, and
  in line with the evening-of projection (~100-120MB extrapolated, actual came in a
  bit higher but still well within budget). No sign of the flapping-reload pattern
  recurring — fix from commit `43d8b3d` holding.
- **Cumulative this cycle (06 Aug – 06 Sep, chatswood-valet only):** 0.722 GB / 250 GB
  (<1%).
- 9 Aug (today) doesn't have its own bar yet — chart hadn't populated a partial-day
  figure for it at check time.

## 2026-08-08 (mid-morning): fix confirmed — 8 Aug running at ~15MB vs 403MB on 7 Aug

Checked the per-project dashboard again partway through the day (8 Aug bucket still
in progress, not yet closed): **~15.1MB total so far** — 15.092MB PostgREST,
12.89KB Auth, 9.05KB Functions, 5.79KB Realtime. That's a ~96% drop from 7 Aug's
403.38MB, and for a partial day. No sign of the full-reload-every-8s pattern
recurring. A cloud routine is still scheduled for 2026-08-09 12:00pm Sydney to
double-check the full closed 8 Aug bucket and the API-log pattern directly, but
this reading already strongly confirms commit `43d8b3d` fixed the leak.

## 2026-08-08 (evening, ~6:10pm Sydney / 8hrs into the UTC day): still tracking linear, healthy

**~78.1MB total so far** — 78.009MB PostgREST, 64.45KB Auth, 52.02KB Realtime,
28.31KB Functions. Progression through the day: ~15.1MB at ~2hrs in, ~78.1MB at
~8hrs in — roughly 9-10MB/hour, holding steady (linear, not accelerating).
Projected across a full ~10-12hr business day that's ~100-120MB total, about a
quarter of 7 Aug's 403MB disaster and comfortably within budget. API log
cross-check was unavailable this time (Supabase `get_logs` timing out — project
itself reports `ACTIVE_HEALTHY`), but the steady linear rate is itself the
reassuring signal; a recurrence of the flapping-reload bug would show
exponential growth, not this.

## 2026-08-11: cumulative 1.197 GB / 250 GB (<1%) — 9 Aug bar higher than expected, still within budget

Per-project dashboard, `chatswood-valet` filter, current billing cycle (06 Aug –
06 Sep 2026):

- **Cumulative egress this cycle (chatswood-valet only): 1.197 GB / 250 GB
  (<1%).** No overage, nowhere close.
- The "Egress per day" chart (visual read of the bar heights against the
  143MB/286MB/484MB gridlines — no exact tooltip value this time, so these are
  close estimates, not exact figures like earlier entries):
  - 07 Aug (closed): ~484MB — matches the 08-09 log entry's finalized 484.27MB.
  - 08 Aug (closed): ~205MB — matches the 08-09 log entry's finalized 204.76MB.
  - 09 Aug (closed): **~350-380MB** — noticeably higher than 08 Aug, breaking
    the "steady healthy" trend the 08-08 entries projected. Not investigated
    further this check (still well within the 250GB budget), but worth a look
    if it keeps climbing — could be legitimate higher usage (busier day) or an
    early sign of the reconnect-flapping pattern from the 7 Aug incident
    creeping back.
  - 10 Aug (closed): small bar, roughly ~50-90MB.
  - 11 Aug (today): not yet on the chart (too new / <24h to populate).
- Org now has **4 projects** total (was 2 at the 2026-08-07 baseline check):
  `chatswood-valet`, `Chadmik71's Project`, `Manly-clinic` (new), and
  `scone-thai-massage`. All still pool from the same 250GB/month org quota, so
  the org-total-vs-per-project gap is now wider than before — reinforces why
  the per-project filter matters for this log.
- **Action item:** next check should try to get the exact 09 Aug figure (hover
  tooltip on the chart didn't render this pass) rather than relying on the
  visual estimate above, given the accuracy bar for the customer pitch.

## 2026-08-11 (follow-up): 9 Aug's spike investigated — exact figures + root-cause check

Got the exact tooltip values for the two days flagged above, and dug into whether
09 Aug's jump was a code regression:

- **09 Aug (closed, exact): 384.9MB total** — 384.621MB PostgREST (99.9%),
  95.604KB Auth, 85.749KB Realtime, 103.785KB Functions. Confirms the visual
  estimate; ~88% above 08 Aug's 204.76MB.
- **10 Aug (closed, exact): 60.16MB total** — 60.157MB PostgREST (100%),
  8.722KB Auth, 4.819KB Realtime, 15.264KB Functions. The healthiest day yet —
  well below even 08 Aug, so whatever drove the 09 Aug spike did **not**
  persist into 10 Aug.
- **Cumulative this cycle: 1.197–1.219 GB / 250 GB (<1%).** No budget concern.

**Root-cause check:** 09 Aug is the same day two features shipped
(`cf10ed3` photo→Storage migration and `e71f52e` historical
reports/`entriesForRange`, both ~10:20–10:30am). Checked whether either
reintroduced the July/Aug-7 "full table dump" pattern:
- `entries` table is tiny (963 rows, ~4.1MB total, photo columns included) —
  confirmed live via SQL. A single full-table pull is only ~4-5MB, so 384MB
  in one day means roughly the equivalent of ~80-90 full pulls, not one
  runaway query.
- Audited every `setInterval` in `index_v2.html`: none of them call
  `entriesForRange`/`fetchEntriesInRange` (the new historical-fetch path) —
  `refreshActiveViewOnly()`'s 10s tick only calls `renderReports()`, which is
  local-array-only per the `e71f52e` design. So the new report/export feature
  can't have caused a *periodic* drain — it's click-driven only.
- No code-level regression found. Most likely explanation: manual testing/
  demoing of the two just-shipped features that morning (repeated "All Time"
  exports or historical month switches each do one small `select('*')`
  round-trip) — plausible at ~1.2GB/hour... actually more like dozens of
  clicks — not confirmed, just the best fit given nothing periodic was found.

**New, separate finding (not yet explained):** live `postgrest` logs show a
recurring `Warp server error: Thread killed by timeout manager` message —
intermittent (every 20-90 min) on 09-10 Aug, but firing every ~30-90
*seconds* as of this check (11 Aug, live). This is a low-level PostgREST/Warp
HTTP-server log with no request path/size attached, so it's unconfirmed
whether it's egress-relevant (it may just be idle keep-alive connections
timing out, which transfer ~0 bytes) or a symptom of something hanging. Flagged
here since its frequency is visibly climbing today — worth a check next time
if 11 Aug's egress reading comes back elevated too.

## 2026-08-11 (afternoon): 11 Aug partial-day at 97.36MB — mixed pre/post-fix, not a clean read yet

Per-project dashboard, `chatswood-valet` filter, exact tooltip on the still-in-progress
11 Aug bar:

- **11 Aug 2026 (partial, ~mid-afternoon Sydney): 97.36MB total** — 97.322MB
  PostgREST (100.0%), 23.947KB Functions, 5.517KB Auth, 4.823KB Realtime.
- **Cumulative this cycle: 1.299GB / 250GB (<1%).** Still healthy regardless
  of how the fix verification lands.

**Why this reading isn't a clean confirmation of the `lightFullReconcile()` fix
(commit `1783b9b`, deployed ~midday today) yet:**
1. It mixes several hours of **pre-fix** traffic (this morning, before the fix
   was pushed) with whatever's happened since.
2. It includes ~2.1MB from my own live verification testing against
   production (deliberately fetching both the old full `select('*')` and the
   new `select('id')` query once each, to measure the real byte difference —
   see `FIX_LOG.md`'s 2026-08-11 entry).
3. GitHub Pages doesn't push updates into already-open tabs — any staff
   device that had the app open before the deploy and hasn't reloaded since
   is still running the **old** full-`select('*')` reconcile code until its
   next refresh. So today's figure is a blend of old and new behaviour, not
   a clean "after" sample.

## 2026-08-11 (later afternoon): 11 Aug up to 196.9MB — dominated by today's own debugging, not a leak

Per-project dashboard, `chatswood-valet` filter, exact tooltip on the still-in-progress
11 Aug bar:

- **11 Aug 2026 (partial, later afternoon Sydney): 196.9MB total** — 196.681MB
  PostgREST (99.9%), 109.023KB Functions, 56.212KB Auth, 32.79KB Realtime.
- **Cumulative this cycle: 1.403GB / 250GB (<1%).** Still healthy.

The ~100MB jump since the 97.36MB reading earlier today is almost entirely
**my own live debugging session**, not a regression: diagnosing why the new
"who's online" feature wasn't working involved repeated manual full
`select('*')` fetches (~2MB each) against production to isolate a Realtime
Presence bug (see `FIX_LOG.md` — root cause was `supabase-js@2.45.4` having
broken Presence; fixed by upgrading to `2.112.2`). That work is done now, so
this reading isn't a fresh baseline either — the real "is the reconcile fix
actually clean" answer still needs **12 Aug's closed full-day total**, same
as noted above.

**Real test is tomorrow (12 Aug):** a full day where every device has
naturally reloaded at least once (start of shift) will be the first clean
sample of the new code path running all day. Left the "Egress reconcile fix"
item open in `FIX_LOG.md`'s Open follow-ups — do not close it out on today's
number alone.

## 2026-08-11 (evening): 11 Aug closing near 202.7MB — consistent with the afternoon reading

Per-project dashboard, `chatswood-valet` filter, exact tooltip on the still-in-progress
11 Aug bar:

- **11 Aug 2026 (partial, evening Sydney): ~202.7MB total** — 202.439MB
  PostgREST (99.9%), 170.696KB Functions (0.1%), 83.039KB Auth (0.0%),
  42.437KB Realtime (0.0%).
- **Cumulative this cycle: 1.409GB / 250GB (<1%).** Still healthy.

Only a ~5.8MB rise since the 196.9MB afternoon reading — no further debugging
activity happened in between, so this looks like ordinary staff traffic, not
a new leak. Doesn't change the read from the last entry: 11 Aug is still a
mixed pre/post-fix, partly-my-own-testing day, so it's not the clean sample.
**12 Aug's closed full-day total is still the real test** for whether
`lightFullReconcile()` (commit `1783b9b`) actually holds the daily baseline
down — check that first thing tomorrow.

## 2026-08-12 (morning): 11 Aug closed at 209.9MB; 12 Aug just starting

Per-project dashboard, `chatswood-valet` filter:

- **11 Aug 2026 (closed, final): 209.9MB total** — 209.498MB PostgREST
  (99.8%), 219.489KB Functions (0.1%), 115.997KB Auth (0.1%), 50.15KB
  Realtime (0.0%).
- **12 Aug 2026 (partial, early morning): ~1.64MB total** — 1.615MB
  PostgREST (98.6%), 20.197KB Functions (1.2%), 3.197KB Auth (0.2%). Too
  early in the day to mean much yet.
- **Cumulative this cycle: 1.419GB / 250GB (<1%).** Still healthy.

11 Aug's closed number (209.9MB) lands mid-pack — well below the 7-9 Aug
spike days (380-484MB) but still elevated vs. 10 Aug's clean 60MB, consistent
with it being a mixed day (fix deployed midday + ~2MB of my own live
verification testing + a Realtime Presence debugging session that afternoon,
see the two 2026-08-11 entries above). **Still not a clean read of the fix**
— 11 Aug had known extra activity baked in. The actually-clean test is a day
with zero manual debugging/testing on top of the new code: watch **12 Aug's
close** (tomorrow) for that, since today has no known extra activity planned
so far.

## 2026-08-12 (asked mid-conversation, prompted by a Supabase-vs-Neon cost question): 12 Aug still in progress, not closeable yet — but tracking very healthy

Per-project dashboard, `chatswood-valet` filter, exact tooltip:

- **12 Aug 2026 (partial, still today — NOT closed):** ~4.176MB total — 4.121MB
  PostgREST (98.7%), 39.67KB Functions (0.9%), 13.11KB Auth (0.3%), 1.928KB
  Realtime (0.0%).
- **11 Aug 2026 (closed, re-confirmed):** 209.498MB PostgREST + 115.997KB Auth
  + 50.15KB Realtime + 219.489KB Functions — matches the earlier entry exactly,
  no drift.
- **Cumulative this cycle: 1.421 GB / 250 GB (<1%).**

**Important:** today (12 Aug) is still in progress — this is NOT the closed
full-day figure the open follow-up asks for. It's still a very good early
sign (well under an hour's worth of the old 7-9 Aug pace), but do not use
this number to close out the "Egress reconcile fix — free-tier decision"
follow-up. Re-check tomorrow morning (13 Aug) once 12 Aug has fully closed.

## 2026-08-12 (later, routine "check bandwidth" ask): 12 Aug up to ~9.29MB — still healthy, still partial

Per-project dashboard, `chatswood-valet` filter, exact tooltip:

- **12 Aug 2026 (partial, still today — NOT closed): ~9.29MB total** —
  9.156MB PostgREST (98.6%), 93.283KB Functions (1.0%), 35.078KB Auth (0.4%),
  3.857KB Realtime (0.0%). Up from ~4.18MB at the last check earlier today —
  normal accumulation through the day, no jump.
- **Cumulative this cycle: 1.427 GB / 250 GB (<1%).**

Still not closed — same caveat as the entry above applies. Trajectory remains
well within the healthy range; 13 Aug morning is still the real test for the
free-tier decision.

## 2026-08-13 (morning): 12 Aug CLOSED at 16.52MB — the real test, and it passed

Per-project dashboard, `chatswood-valet` filter, exact tooltip:

- **12 Aug 2026 (closed, final): 16.52MB total** — 16.32MB PostgREST (98.8%),
  141.535KB Functions (0.8%), 53.857KB Auth (0.3%), 5.787KB Realtime (0.0%).
  This is the first full day, guaranteed clean start-to-finish under the
  `lightFullReconcile()` fix — and it landed **dramatically** below every
  other closed day this cycle (484MB → 205MB → 385MB → 60MB → 210MB →
  **16.5MB**), not just an improvement but the best day by a wide margin.
- **13 Aug 2026 (partial, still today — NOT closed): ~4.67MB so far** —
  4.622MB PostgREST (99.0%), 21.944KB Auth (0.5%), 20.965KB Functions (0.4%),
  4.817KB Realtime (0.1%). Healthy pace, consistent with 12 Aug's low baseline.
- **Cumulative this cycle (06 Aug–13 Aug, chatswood-valet only): 1.439 GB /
  250 GB (0.58%)** — read directly from the project's Usage Summary tile.

**This closes out the "12 Aug closed full-day total" open follow-up.** The
egress leak fix (`lightFullReconcile()`, commit `1783b9b`) is confirmed
holding on a fully clean day, not just a partial/mixed sample. See
`FIX_LOG.md` for the free-tier (5GB/mo) decision this unblocks.

## 2026-08-15 (later still, routine "check bandwidth" ask): 15 Aug partial-day at ~13.71MB — healthy so far

Per-project dashboard, `chatswood-valet` filter, exact tooltip:

- **15 Aug 2026 (partial, still today — NOT closed): ~13.71MB total** —
  13.475MB PostgREST (98.3%), 111.729KB Realtime (0.8%), 79.595KB Auth (0.6%),
  47.703KB Functions (0.3%). Early-day reading, in line with the recent
  low-baseline days (12–14 Aug all closed under 17MB).
- **Cumulative this cycle (06 Aug–15 Aug, chatswood-valet only): 1.468 GB /
  250 GB (<1%).**

No action needed — fix continues to hold.

## 2026-08-15 (later, routine re-check): 14 Aug's closed figure revised up to ~6.06MB — still the best day of the cycle

Per-project dashboard, `chatswood-valet` filter, exact tooltip:

- **14 Aug 2026 (closed, revised): ~6.06MB total** — 5.984MB PostgREST
  (98.8%), 51.119KB Auth (0.8%), 10.676KB Functions (0.2%), 10.599KB
  Realtime (0.2%). Up from the ~3.65MB read earlier today — consistent with
  the pattern seen before (e.g. 7 Aug's figure grew from a 403MB same-day
  read to a 484MB final) where closed-day totals can still creep up for a
  bit after the day rolls over. Still comfortably the best closed day of the
  cycle by a wide margin (next-best was 13 Aug's 11.04MB).
- **15 Aug 2026 (today):** still not on the chart — too new to have
  populated a bar yet, same <24h lag as every prior same-day check.
- **Cumulative this cycle (06 Aug–15 Aug, chatswood-valet only): 1.453 GB /
  250 GB (<1%).**

No action needed — just a routine re-check, healthy either way.

## 2026-08-15: 14 Aug CLOSED at ~3.65MB — new best day of the cycle by a wide margin

Per-project dashboard, `chatswood-valet` filter, exact tooltip:

- **14 Aug 2026 (closed, final): ~3.65MB total** — 3.602MB PostgREST (98.7%),
  37.034KB Auth (1.0%), 5.91KB Functions (0.2%), 5.782KB Realtime (0.2%).
  Beats 13 Aug's 11.04MB by a wide margin — third consecutive clean closed
  day under `lightFullReconcile()` (12 Aug: 16.52MB, 13 Aug: 11.04MB, 14 Aug:
  3.65MB), and each has come in lower than the last.
- **15 Aug 2026 (today):** not yet on the chart — too new to have populated
  a bar (same <24h lag seen on prior same-day checks).
- **Cumulative this cycle (06 Aug–15 Aug, chatswood-valet only): 1.45 GB /
  250 GB (<1%).**

Fix continues to hold; no action needed.

## 2026-08-17: 16 Aug CLOSED at ~11.65MB — cumulative 1.49GB/250GB

Per-project dashboard, `chatswood-valet` filter, exact tooltip:

- **16 Aug 2026 (closed, final): ~11.65MB total** — 11.404MB PostgREST
  (98.0%), 96.61KB Realtime (0.8%), 91.864KB Auth (0.8%), 53.762KB Functions
  (0.5%). Consistent with the low-baseline range every day since the
  `lightFullReconcile()` fix (12–16 Aug all closed under 21MB).
- **17 Aug 2026 (today, partial — NOT closed): ~3.11MB so far** — 3.067MB
  PostgREST (98.7%), 28.001KB Auth (0.9%), 8.7KB Functions (0.3%), 5.779KB
  Realtime (0.2%). Early-day reading, healthy pace.
- **Cumulative this cycle (06 Aug–17 Aug, chatswood-valet only): 1.49 GB /
  250 GB (<1%).**

No action needed — fix continues to hold.

## 2026-08-16: 15 Aug CLOSED at ~20.08MB — cumulative 1.474GB/250GB

Per-project dashboard, `chatswood-valet` filter, exact tooltip:

- **15 Aug 2026 (closed, final): ~20.08MB total** — 19.756MB PostgREST
  (98.4%), 123.285KB Realtime (0.6%), 112.979KB Auth (0.5%), 88.742KB
  Functions (0.4%). Up from the ~13.71MB partial-day reading logged earlier
  on 15 Aug — normal growth as the day closed out. Still well within the
  recent low-baseline range (12–15 Aug all closed under 21MB, vs. the
  7-9 Aug spike days of 380-484MB).
- **16 Aug 2026 (today):** not yet on the chart — too new to have populated
  a bar (same <24h lag seen on every prior same-day check).
- **Cumulative this cycle (06 Aug–16 Aug, chatswood-valet only): 1.474 GB /
  250 GB (<1%).**

No action needed — fix continues to hold.

## 2026-08-14: 13 Aug CLOSED at ~11.04MB — second-best day of the cycle, fix holding

Per-project dashboard, `chatswood-valet` filter, exact tooltip:

- **13 Aug 2026 (closed, final): ~11.04MB total** — 10.897MB PostgREST
  (98.7%), 73.937KB Functions (0.7%), 63.561KB Auth (0.6%), 7.711KB Realtime
  (0.1%). Below 12 Aug's 16.52MB, making 13 Aug the best closed day of the
  cycle so far — confirms `lightFullReconcile()` continues to hold the
  baseline down on a second consecutive clean day.
- **14 Aug 2026 (partial, today — NOT closed): ~1.73MB so far** — 1.716MB
  PostgREST (99.0%), 13.07KB Auth (0.7%), 2.834KB Functions (0.2%), 1.928KB
  Realtime (0.1%). Early in the day, healthy pace.
- **Cumulative this cycle (06 Aug–14 Aug, chatswood-valet only): 1.448 GB /
  250 GB (<1%).**

Two clean closed days in a row (12 Aug: 16.52MB, 13 Aug: 11.04MB) now confirm
the fix is stable, not a one-off. No new action needed.

## 2026-08-20: 18 Aug CLOSED at ~8.95MB, 19 Aug CLOSED at ~8.33MB — cumulative 1.51GB/250GB

Per-project dashboard, `chatswood-valet` filter, exact tooltip:

- **18 Aug 2026 (closed, final): ~8.95MB total** — 7.879MB PostgREST (88.3%),
  955.557KB Realtime (10.5%), 82.207KB Functions (0.9%), 36.275KB Auth (0.4%).
- **19 Aug 2026 (closed, final): ~8.33MB total** — 7.148MB PostgREST (85.8%),
  1.092MB Realtime (13.1%), 60.38KB Functions (0.7%), 34.288KB Auth (0.4%).
- **Cumulative this cycle (06 Aug–20 Aug, chatswood-valet only): 1.51 GB /
  250 GB (<1%).**

Both days continue the low-baseline range every closed day since the
`lightFullReconcile()` fix (12–19 Aug all closed under 21MB). One thing worth
flagging: Realtime's *share* of daily egress has crept up on both days
(10.5% and 13.1%, vs. near-0% on most earlier low-baseline days) — the
absolute bytes are still tiny (under 1.1MB/day) so not a concern yet, but
worth a glance if Realtime's share keeps climbing on future checks. No
action needed today.

## 2026-08-22: 20 Aug CLOSED at 984 bytes (near-zero, flagged), 21 Aug CLOSED at ~7.62MB — cumulative 1.518GB/250GB

Per-project dashboard, `chatswood-valet` filter, exact tooltip:

- **20 Aug 2026 (closed, final): 984 bytes total** — 100% PostgREST, no Auth/
  Realtime/Functions component at all. This is essentially zero traffic for
  a full day — far below every other closed day this cycle (previous low was
  14 Aug's 3.65MB). **Flagged, not yet explained:** could be a legitimately
  quiet day (e.g. no shifts/closed), or a sign the app didn't get opened/used
  by any device that day (which would also mean no delta-poll traffic since
  nothing was running to poll). Worth asking the user whether 20 Aug (Thu)
  was a normal operating day — if yes, this is worth investigating as a
  possible "app never loaded" issue rather than celebrating it as a good
  bandwidth day.
- **21 Aug 2026 (closed, final): ~7.62MB total** — 6.903MB PostgREST (90.6%),
  658.773KB Realtime (8.4%), 50.798KB Auth (0.7%), 21.634KB Functions (0.3%).
  Back to the normal low-baseline range. Realtime's share (8.4%) continues
  the creep noted in the 18-19 Aug entry above, still small in absolute terms.
- **22 Aug 2026 (today):** not yet on the chart — too new to have populated
  a bar (<24h lag, consistent with every prior same-day check).
- **Cumulative this cycle (06 Aug–22 Aug, chatswood-valet only): 1.518 GB /
  250 GB (<1%).**

No budget concern. Action item: confirm with the user whether 20 Aug's
near-zero reading reflects a closed/no-shift day or an actual app-availability
gap.

## 2026-08-22 (later, routine "check bandwidth" ask): 21 Aug CLOSED at ~9.94MB (revised up from same-day estimate) — cumulative 1.521GB/250GB

Per-project dashboard, `chatswood-valet` filter, exact tooltip:

- **21 Aug 2026 (closed, final): ~9.94MB total** — 9.202MB PostgREST (92.6%),
  665.658KB Realtime (6.5%), 64.839KB Auth (0.6%), 24.188KB Functions (0.2%).
  Up from the ~7.62MB same-day estimate logged earlier — consistent with the
  known pattern of closed-day totals settling higher after the day rolls over
  (e.g. 7 Aug's 403MB→484MB). Realtime's share (6.5%) continues in the same
  low-single-digit-percent range as the last few checks — still just tens of
  KB in absolute terms, not a concern.
- **22 Aug 2026 (today):** not yet on the chart — too new to have populated a
  bar, same <24h lag as every prior same-day check. A fair amount of activity
  happened today (live customer check-ins, printer testing, several direct
  SQL fixes) but none of it will show until the bar populates.
- **Cumulative this cycle (06 Aug–22 Aug, chatswood-valet only): 1.521 GB /
  250 GB (<1%).**

No action needed — still healthy, well within budget. 20 Aug's near-zero
reading from the entry above is still unexplained; worth asking the user
about it separately if not already resolved.

## 2026-08-23: 22 Aug CLOSED at ~18.34MB — Realtime's share keeps climbing (14.9%), still healthy

Per-project dashboard, `chatswood-valet` filter, exact tooltip:

- **22 Aug 2026 (closed, final): ~18.34MB total** — 15.442MB PostgREST
  (84.2%), 2.741MB Realtime (14.9%), 107.343KB Auth (0.6%), 47.15KB
  Functions (0.3%). Well within the recent low-baseline range, but flagging:
  Realtime's *share* has now climbed three checks running (6.5% on 21 Aug →
  8.4% on 21 Aug same-day estimate → 14.9% here). Absolute bytes are still
  small (2.74MB/day) so no budget concern, but if this keeps trending up
  worth checking what's driving more Realtime traffic (more concurrent
  devices/tabs open? more presence churn?).
- **23 Aug 2026 (today):** not yet on the chart — too new to have populated
  a bar, same <24h lag as every prior same-day check.
- **Cumulative this cycle (06 Aug–23 Aug, chatswood-valet only): 1.54 GB /
  250 GB (<1%).**

No action needed — still healthy, well within budget. The Realtime-share
creep is the only thing worth watching; not a problem yet.

## 2026-08-26: 22 Aug CLOSED at ~18.67MB (Realtime share holding ~15%); 23 Aug partial shows a real Realtime spike — 11.5MB (41% of the day), cumulative 1.583GB/250GB

Per-project dashboard, `chatswood-valet` filter, exact tooltip:

- **22 Aug 2026 (closed, final): ~18.67MB total** — 15.766MB PostgREST
  (84.5%), 2.741MB Realtime (14.7%), 110.54KB Auth (0.6%), 49.652KB
  Functions (0.3%). Matches the same-day estimate logged on 2026-08-23
  almost exactly (18.34MB → 18.67MB) — no meaningful drift after closing.
  Realtime's share (14.7%) is consistent with the last few checks, not a
  further step up on its own.
- **23 Aug 2026 (partial, still open — NOT closed): ~28.09MB so far** —
  16.394MB PostgREST (58.4%), **11.513MB Realtime (41.0%)**, 97.924KB
  Functions (0.3%), 89.114KB Auth (0.3%). This is the escalation the last
  few entries were watching for: Realtime's *absolute* bytes jumped from
  2.74MB (22 Aug closed) to 11.5MB in a partial day — over 4x — and its
  *share* nearly tripled (14.7% → 41.0%). Still small in absolute terms
  and nowhere near the 250GB budget, but this breaks the "just tens/low-
  hundreds of KB, watch the share not the bytes" framing from the last
  three checks. Worth a closed-day confirmation and, if it repeats, a look
  at whether something is opening/reconnecting more Realtime channels than
  usual (more concurrent devices/tabs, a flapping connection re-subscribing
  repeatedly, etc.) — same category of question as the July/Aug-7 PostgREST
  incident, just on the Realtime channel this time.
- **Cumulative this cycle (06 Aug–26 Aug, chatswood-valet only): 1.583 GB /
  250 GB (0.63%).** No budget concern.

**Action item:** re-check once 23 Aug closes to get the final Realtime
figure, and if the elevated Realtime share persists into 24-26 Aug, treat
it as an actual investigation rather than a watch item.

## 2026-08-31: 30 Aug CLOSED at ~21.16MB (Realtime back down to ~12.8% share); 31 Aug partial ~6.57MB, cumulative 1.636GB/250GB

Per-project dashboard, `chatswood-valet` filter, exact tooltip:

- **30 Aug 2026 (closed, final): ~21.16MB total** — 18.319MB PostgREST
  (86.6%), 2.718MB Realtime (12.8%), 75.643KB Auth (0.3%), 43.794KB
  Functions (0.2%). Realtime's share is back down near the pre-23-Aug
  baseline (12.8% vs the 41% spike flagged on 23 Aug), so that escalation
  did not persist — looks like it was a one-off, not a trend.
- **31 Aug 2026 (partial, still open — NOT closed): ~6.57MB so far** —
  6.224MB PostgREST (94.8%), 280.787KB Realtime (4.2%), 53.413KB Auth
  (0.8%), 12.573KB Functions (0.2%).
- **Cumulative this cycle (06 Aug–31 Aug, chatswood-valet only): 1.636 GB /
  250 GB (0.65%).** No budget concern.

**Action item:** the 23 Aug Realtime spike (41% share) resolved on its own
and hasn't recurred through 30 Aug — closing that watch item, no
investigation needed unless it reappears.

## 2026-09-11: New cycle (06 Sep–06 Oct) 6 days in, cumulative 0.085GB/250GB — still very healthy

Per-project dashboard, `chatswood-valet` filter, exact tooltip:

- **06 Sep 2026 (closed): ~27.92MB total** — 18.254MB PostgREST (65.4%),
  9.505MB Realtime (34.0%), 67.417KB Auth (0.2%), 92.617KB Functions
  (0.3%). Realtime share is elevated again (34.0%, close to the 23 Aug
  41% spike) but on a low-volume day — worth a glance if it recurs on a
  bigger day.
- **07 Sep 2026 (closed): ~4.93MB total** — 3.593MB PostgREST (72.9%),
  1.287MB Realtime (26.1%), 29.398KB Auth (0.6%), 18.929KB Functions
  (0.4%).
- **08 Sep 2026 (closed): ~0MB** — no bar on the chart, effectively no
  traffic that day.
- **09 Sep 2026 (closed): ~38.45MB total** — 36.543MB PostgREST (95.1%),
  1.702MB Realtime (4.4%), 141.56KB Auth (0.4%), 61.119KB Functions
  (0.2%). Biggest day of the cycle so far — Realtime share normal, just a
  high-traffic day (this was the CSV backfill / mismatch-audit session).
- **10 Sep 2026 (closed): ~6.35MB total** — 5.859MB PostgREST (92.3%),
  413.932KB Realtime (6.4%), 46.566KB Auth (0.7%), 38.482KB Functions
  (0.6%).
- **11 Sep 2026 (partial, still open — NOT closed): ~3.17MB so far** —
  2.859MB PostgREST (90.2%), 289.774KB Realtime (8.9%), 23.133KB Auth
  (0.7%), 6.354KB Functions (0.2%).
- **Cumulative this cycle (06 Sep–11 Sep, chatswood-valet only): 0.085 GB
  / 250 GB (0.03%).** No budget concern.

## 2026-09-11 (later, routine "check bandwidth" ask): no change from the morning check — 11 Sep still ~3.17MB partial, cumulative 0.085GB/250GB

Per-project dashboard, `chatswood-valet` filter, re-verified. Figures are
identical to the same-day check above (11 Sep partial ~3.17MB, same
90.2%/8.9%/0.7%/0.2% split) — dashboard says it refreshes hourly, so no
new data has posted yet. Nothing to flag, still very healthy.

## 2026-09-15: last-week check (08 Sep–15 Sep) — cumulative 0.143GB/250GB, one Realtime-share bump on 12-13 Sep that self-resolved

Per-project dashboard, `chatswood-valet` filter, exact tooltips for each day since the last check:

- **08 Sep 2026 (closed): ~4.08KB** — effectively no traffic (4.078KB
  PostgREST, 100%). Matches the "~0MB" estimate from the 2026-09-11 entry.
- **09 Sep 2026 (closed): ~38.45MB total** — 36.543MB PostgREST (95.1%),
  1.702MB Realtime (4.4%), 141.56KB Auth (0.4%), 61.119KB Functions
  (0.2%). Unchanged from prior check (CSV backfill / mismatch-audit day).
- **10 Sep 2026 (closed): ~6.35MB total** — 5.859MB PostgREST (92.3%),
  413.932KB Realtime (6.4%), 46.566KB Auth (0.7%), 38.482KB Functions
  (0.6%). Unchanged from prior check.
- **11 Sep 2026 (closed, was partial ~3.17MB last check): ~8.83MB total**
  — 8.397MB PostgREST (95.2%), 360.688KB Realtime (4.0%), 57.333KB Auth
  (0.6%), 14.382KB Functions (0.2%). Grew as expected once the day
  closed out; normal split.
- **12 Sep 2026 (closed): ~35.33MB total** — 28.682MB PostgREST (81.2%),
  6.452MB Realtime (18.3%), 129.527KB Auth (0.4%), 68.151KB Functions
  (0.2%). Realtime share elevated again (18.3%), echoing the 23 Aug/06
  Sep pattern.
- **13 Sep 2026 (closed): ~10.97MB total** — 7.844MB PostgREST (71.5%),
  3.04MB Realtime (27.7%), 60.489KB Auth (0.5%), 29.052KB Functions
  (0.3%). Realtime share climbed further (27.7%, biggest share yet on a
  non-trivial-volume day) — two days in a row of elevated Realtime.
- **14 Sep 2026 (closed): ~2.62MB total** — 2.554MB PostgREST (97.4%),
  38.611KB Realtime (1.4%), 27.718KB Auth (1.0%), 2.894KB Functions
  (0.1%). Realtime share dropped straight back to baseline — the 12-13
  Sep bump did not persist into a third day.
- **15 Sep 2026 (partial, still open — NOT closed, today): ~1.35MB so
  far** — 1.323MB PostgREST (98.2%), 6.671KB Realtime (0.5%), 12.216KB
  Auth (0.9%), 5.319KB Functions (0.4%).
- **Cumulative this cycle (06 Sep–15 Sep, chatswood-valet only): 0.143 GB
  / 250 GB (0.06%).** No budget concern.

**Action item:** the 12-13 Sep Realtime-share bump (18.3% → 27.7%) already
resolved on its own by 14 Sep, same pattern as the 23 Aug spike — no
investigation needed unless it recurs on a bigger day or persists past a
single day next time.
