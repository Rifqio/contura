# Measures Contura's memory: contura.exe plus all its descendant processes
# (the msedgewebview2.exe children), found by walking Win32_Process.ParentProcessId.
#
# The budget metric is the PRIVATE working set summed over those processes
# (ADR 0003): under 150 MB. The plain working set total is printed for
# reference only; it counts shared DLL pages once per process.
#
# One reading depends on when it falls relative to the WebView's garbage
# collection, so the script takes three samples 10 s apart and judges the
# minimum (ADR 0003, 2026-10-16).
#
# Before running: open one Connection, close any table, and wait 30 s.
# Drive the app by hand or over the remote debugging port, not with UI
# automation: automation turns on Chromium accessibility and inflates every figure.
# Exit codes: 0 under budget, 1 at or over budget, 2 contura.exe not running.

param(
    [int]$Samples = 3,
    [int]$IntervalSeconds = 10
)

$BudgetMB = 150

function Measure-Once {
    $all = Get-CimInstance Win32_Process
    $roots = @($all | Where-Object { $_.Name -eq 'contura.exe' })
    if ($roots.Count -eq 0) { return $null }

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
    [pscustomobject]@{
        PrivateMB    = $privateBytes / 1MB
        WorkingSetMB = $wsBytes / 1MB
        Count        = $found.Count
        Rows         = $rows
    }
}

$taken = @()
for ($i = 1; $i -le $Samples; $i++) {
    if ($i -gt 1) { Start-Sleep -Seconds $IntervalSeconds }
    $s = Measure-Once
    if ($null -eq $s) {
        [Console]::Error.WriteLine('contura.exe is not running.')
        exit 2
    }
    Write-Host ("Sample {0} of {1}: {2:N1} MB private, {3:N1} MB working set" -f $i, $Samples, $s.PrivateMB, $s.WorkingSetMB)
    $taken += $s
}

$min = $taken | Sort-Object PrivateMB | Select-Object -First 1
$min.Rows | Sort-Object Pid | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

Write-Host ("Private working set total (minimum of {0} samples): {1:N1} MB across {2} processes (budget < {3} MB, ADR 0003)" -f $Samples, $min.PrivateMB, $min.Count, $BudgetMB)
Write-Host ("Working set total of that sample (includes shared pages): {0:N1} MB" -f $min.WorkingSetMB)

if ($min.PrivateMB -ge $BudgetMB) { exit 1 }
exit 0
