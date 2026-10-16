# Memory budget

Low memory use is a hard requirement, because Navicat's weight is the main reason for building DB View. With one open Connection, DB View stays under about 150 MB at idle. Table data and query results are fetched a page at a time (on the order of 1,000 rows) and never loaded whole. Closing a tab releases its rows. A feature that can't meet these rules needs a new ADR, not a quiet exception.

## How it is measured (decided 2026-10-15)

The 150 MB is the **private working set** summed over `db-view.exe` and all its WebView2 child processes, which is what Task Manager's default Memory column shows. `scripts/measure-memory.ps1` reports both this total and the plain working-set total, and fails on the private total.

The decision figure is **105.1 MB private** with one Connection open (table closed, 30 s idle), re-measured for this decision, which leaves about 45 MB of headroom under the 150 MB budget. Across the step 1 end-to-end runs the same measure ranged from 85.6 to 141 MB private, so a busy session can come within about 10 MB of the limit. The summed working set was about 450 MB. The gap is WebView2 runtime pages shared with Edge and other WebView2 apps, which a working-set sum counts once per process. ADR 0001's estimate of 80–150 MB WebView2 overhead was too low by the working-set measure. The user chose to judge DB View by the memory it actually owns rather than to raise the budget or drop WebView2.

## Sampling rule (2026-10-16)

A single reading is not reliable. Step 1 measured 105 MB and step 2 measured 130 MB with the same protocol, yet both builds behave the same: the gap was only where the sample fell relative to the WebView's garbage collection. `scripts/measure-memory.ps1` therefore takes three samples 10 s apart and judges the minimum. Drive the app by hand or over the remote debugging port, not with UI automation: automation turns on Chromium accessibility, which adds about 10 MB idle and about 90 MB while a grid is open. The data grid is virtualized, rendering only the rows near the viewport instead of all 1,000 rows of a page (about 39,000 DOM nodes for 12 columns), so an open grid now stays small. Re-measured on the step 2 release build over the remote debugging port, with one PostgreSQL Connection: **100.6 MB private** for the protocol (a table opened and closed, 30 s idle) and **104.1 MB private** with a 12-column table open, against about 210 to 245 MB with that table open before the grid was virtualized.

## Large Schema Models (2026-10-16)

The 150 MB budget covers idle use with one open Connection. A large Schema Model with every card in view is an accepted exception. On the step 3 release build, measured with the protocol above and one PostgreSQL Connection open:

| State | Private working set |
|---|---|
| Fresh launch, Connection open | 91.3 MB |
| A generated 300-table model open, all cards in view | 200.8 MB |
| After closing the model | 107.4 MB |

The JS heaps are small (about 20 MB on the page and 3 MB in the DBML worker after garbage collection). The cost is the live DOM: about 13,000 nodes, roughly 44 per card. The canvas opens fitted to the whole model, so every card is in view and culling (`onlyRenderVisibleElements`) removes nothing. The user chose to accept this rather than add compact cards at low zoom or cap the opening zoom. Either remains the fix if large models become common.
