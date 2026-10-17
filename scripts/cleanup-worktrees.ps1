# Removes git worktrees whose branch is merged into main and that have no
# uncommitted or untracked files. Skips the main checkout, locked worktrees
# and the worktree this session runs in. Run by the SessionStart hook.
$ErrorActionPreference = 'SilentlyContinue'
$common = git rev-parse --path-format=absolute --git-common-dir 2>$null
if (-not $common) { exit 0 }
$repo = Split-Path $common -Parent
$here = @((Get-Location).Path, $env:CLAUDE_PROJECT_DIR) | Where-Object { $_ } |
    ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\').ToLower() }

$trees = @(); $cur = $null
foreach ($line in (git -C $repo worktree list --porcelain)) {
    if ($line -like 'worktree *') { $cur = @{ path = $line.Substring(9); branch = $null; locked = $false }; $trees += $cur }
    elseif ($line -like 'branch refs/heads/*') { $cur.branch = $line.Substring(18) }
    elseif ($line -like 'locked*') { $cur.locked = $true }
}

$removed = @()
foreach ($t in $trees) {
    $full = [IO.Path]::GetFullPath($t.path).TrimEnd('\').ToLower()
    if ($full -eq $repo.TrimEnd('\').ToLower()) { continue }
    if ($t.locked -or -not $t.branch -or $t.branch -eq 'main') { continue }
    if ($here | Where-Object { $_ -eq $full -or $_.StartsWith($full + '\') }) { continue }
    git -C $repo merge-base --is-ancestor $t.branch main
    if ($LASTEXITCODE -ne 0) { continue }
    if (git -C $t.path status --porcelain) { continue }
    git -C $repo worktree remove $t.path 2>$null
    if ($LASTEXITCODE -ne 0) {
        # Long build paths can defeat git; the tree is clean, so delete it directly.
        Remove-Item -LiteralPath $t.path -Recurse -Force
        git -C $repo worktree prune
    }
    if (-not (Test-Path -LiteralPath $t.path)) {
        git -C $repo branch -d $t.branch 2>$null | Out-Null
        $removed += $t.branch
    }
}
if ($removed.Count) { "Removed merged worktrees: $($removed -join ', ')" }