# Memory budget

Low memory use is a hard requirement, because Navicat's weight is the main reason for building DB View. With one open Connection, DB View stays under about 150 MB at idle. Table data and query results are fetched a page at a time (on the order of 1,000 rows) and never loaded whole. Closing a tab releases its rows. A feature that can't meet these rules needs a new ADR, not a quiet exception.

## How it is measured (decided 2026-10-15)

The 150 MB is the **private working set** summed over `db-view.exe` and all its WebView2 child processes, which is what Task Manager's default Memory column shows. `scripts/measure-memory.ps1` reports both this total and the plain working-set total, and fails on the private total.

The decision figure is **105.1 MB private** with one Connection open (table closed, 30 s idle), re-measured for this decision, which leaves about 45 MB of headroom under the 150 MB budget. Across the step 1 end-to-end runs the same measure ranged from 85.6 to 141 MB private, so a busy session can come within about 10 MB of the limit. The summed working set was about 450 MB. The gap is WebView2 runtime pages shared with Edge and other WebView2 apps, which a working-set sum counts once per process. ADR 0001's estimate of 80 to 150 MB WebView2 overhead was too low by the working-set measure. The user chose to judge DB View by the memory it actually owns rather than to raise the budget or drop WebView2.

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

## AI assistant (2026-10-22)

The AI assistant adds a local index and long answers, so it was measured on its own. The 150 MB budget above is a Windows figure: these readings were taken on Linux (WebKitGTK), where the webview is a different engine, so they are not directly comparable with it. Protocol: a release build on Linux, `scripts/measure-memory.sh --pid <n> --samples 3 --interval 3`, the minimum of three samples, with private and total MB summed over the app's processes, against a local fixture provider.

| State | Private | Total |
|---|---|---|
| Idle | 271.1 MB | 546.2 MB |
| During a long answer | 526.1 MB | 807.8 MB |
| 30 s after the answer | 536.8 MB | 818.5 MB |
| During a 2,000-table re-sync | 566.7 MB | 848.5 MB |
| 30 s after the re-sync | 570.9 MB | 852.7 MB |

Per process, the `contura` process held 61 MB private at idle and 83 MB at the last reading (30 s after the scripted AI session: the long answer and the 2,000-table re-sync), while WebKitWebProcess held 196 MB at idle and 711 MB at that reading. A 2,000-table re-sync finishes in under half a second, so its reading was taken while the re-sync was repeated.

The Rust process stays well inside the budget; the webview's growth over a session is still under investigation, and the outcome will be recorded here before 1.0.

## Boards at the limit (2026-10-26, updated 2026-10-29 for Epic F)

A full board is an accepted exception to the idle budget, as the 300-table model is: every frame can be in view, and the canvas fits to it. Measured in the release build on Linux (WebKitGTK, 1920x1080, `scripts/measure-memory.sh`, cgroup `MemoryMax` 3 GB), the numbers are Linux figures and not comparable with the Windows budget above.

| Board | Private at Fit | Sweep peak (Fit to 400 percent and back) | Idle after |
|---|---|---|---|
| B1 limit (50 frames, 10,000 shapes, 1,000 sketches) | 566 to 613 MB | 917 to 948 MB | 591 to 635 MB |
| 2,000-table ERD (build `f83ef400`) | 566 to 593 MB | 917 to 943 MB | 591 to 619 MB |

Plan B1 measured 709 MB private and 1,052 MB total at Fit; those stay the gates, and the sweep peak may be no higher than 1,052 MB. Before Epic F the same sweep peaked near 1,750 MB.

Known limits for 1.0 (owner, 2026-10-29), kept with their numbers in ADR 0019, "Zoom on boards":

- The 50-frame board without sketches (`f50nosk`) misses: about 848 MB private at Fit, about 1,380 MB at the sweep peak, and mid-zoom frames of 83 to 91 ms.
- Opening a pictured board shows a worst frame of about 210 ms (limit board) and 90 to 100 ms (ERD) while pictures fill in, against a 50 ms gate.
- The sequence limit board (`seq2000`: 40 flowchart frames and one sequence of 2,000 participants and 3,000 messages, 10,000 shapes) misses: about 930 to 950 MB private and 1,240 to 1,260 MB total at Fit, a sweep peak near 1,270 MB, and a worst opening frame of 120 to 145 ms. It was first measured with Epic E (2026-10-29); main before Epic E misses too, at about 875 to 900 MB private, with zoom frames of 760 to 870 ms that Epic E removes. Epic E adds about 55 MB here, a known limit kept for after 1.0.

The levers left cost memory, because WebKit keeps every decoded SVG document, so they stay a post-1.0 item.
