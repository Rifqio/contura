# Memory budget

Low memory use is a hard requirement, because Navicat's weight is the main reason for building DB View. With one open Connection, DB View stays under about 150 MB at idle. Table data and query results are fetched a page at a time (on the order of 1,000 rows) and never loaded whole. Closing a tab releases its rows. A feature that can't meet these rules needs a new ADR, not a quiet exception.

## How it is measured (decided 2026-10-15)

The 150 MB is the **private working set** summed over `db-view.exe` and all its WebView2 child processes, which is what Task Manager's default Memory column shows. `scripts/measure-memory.ps1` reports both this total and the plain working-set total, and fails on the private total.

The decision figure is **105.1 MB private** with one Connection open (table closed, 30 s idle), re-measured for this decision, which leaves about 45 MB of headroom under the 150 MB budget. Across the step 1 end-to-end runs the same measure ranged from 85.6 to 141 MB private, so a busy session can come within about 10 MB of the limit. The summed working set was about 450 MB. The gap is WebView2 runtime pages shared with Edge and other WebView2 apps, which a working-set sum counts once per process. ADR 0001's estimate of 80–150 MB WebView2 overhead was too low by the working-set measure. The user chose to judge DB View by the memory it actually owns rather than to raise the budget or drop WebView2.
