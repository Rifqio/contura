# A Visual Query stays within one Connection

A Visual Query can use any table its Connection can reach, such as several Postgres schemas or several MySQL databases on one server. It cannot join tables from different Connections. Cross-Connection joins would mean DB View fetching both sides and joining them in memory, which breaks the memory budget (ADR 0003). The database also can't optimise a join it never sees. Moving data between Connections is Data Transfer's job.
