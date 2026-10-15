# Measures DB View's memory: db-view.exe plus all its descendant processes
# (the msedgewebview2.exe children), found by walking Win32_Process.ParentProcessId.
#
# The budget metric is the PRIVATE working set summed over those processes
# (ADR 0003): under 150 MB. The plain working set total is printed for
# reference only; it counts shared DLL pages once per process.
#
# Before running: open one Connection, close any table, and wait 30 s.
# Exit codes: 0 under budget, 1 at or over budget, 2 db-view.exe not running.

$BudgetMB = 150

$all = Get-CimInstance Win32_Process
$roots = @($all | Where-Object { $_.Name -eq 'db-view.exe' })
if ($roots.Count -eq 0) {
    [Console]::Error.WriteLine('db-view.exe is not running.')
    exit 2
}

$byParent = @{}
foreach ($p in $all) {
    $key = [int]$p.ParentProcessId
    if (-not $byParent.ContainsKey($key)) { $byParent[$key] = @() }
    $byParent[$key] += $p
}

$found = New-Object System.Collections.Generic.List[object]
$seen = @{}
$queue = New-Object System.Collections.Generic.Queue[object]
foreach ($r in $roots) { $queue.Enqueue($r) }
while ($queue.Count -gt 0) {
    $p = $queue.Dequeue()
    $id = [int]$p.ProcessId
    if ($seen.ContainsKey($id)) { continue }
    $seen[$id] = $true
    $found.Add($p)
    if ($byParent.ContainsKey($id)) {
        foreach ($c in $byParent[$id]) { $queue.Enqueue($c) }
    }
}

$perf = @{}
foreach ($row in Get-CimInstance Win32_PerfFormattedData_PerfProc_Process) {
    $perf[[int]$row.IDProcess] = $row
}

$privateBytes = [double]0
$wsBytes = [double]0
$rows = foreach ($p in $found) {
    $id = [int]$p.ProcessId
    if ($perf.ContainsKey($id)) {
        $priv = [double]$perf[$id].WorkingSetPrivate
        $source = 'perf WorkingSetPrivate'
    } else {
        $gp = Get-Process -Id $id -ErrorAction SilentlyContinue
        $priv = if ($gp) { [double]$gp.PrivateMemorySize64 } else { 0 }
        $source = 'fallback PrivateMemorySize64'
    }
    $privateBytes += $priv
    $wsBytes += [double]$p.WorkingSetSize
    [pscustomobject]@{
        Pid          = $id
        Name         = $p.Name
        WorkingSetMB = [math]::Round($p.WorkingSetSize / 1MB, 1)
        PrivateWSMB  = [math]::Round($priv / 1MB, 1)
        PrivateFrom  = $source
    }
}
$rows | Sort-Object Pid | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

$privateMB = $privateBytes / 1MB
Write-Host ("Private working set total: {0:N1} MB across {1} processes (budget < {2} MB, ADR 0003)" -f $privateMB, $found.Count, $BudgetMB)
Write-Host ("Working set total (includes shared pages): {0:N1} MB" -f ($wsBytes / 1MB))

if ($privateMB -ge $BudgetMB) { exit 1 }
exit 0
