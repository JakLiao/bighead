$ErrorActionPreference = "Continue"
$scripts = @(
  "verify-camera.mjs",
  "verify-burst.mjs",
  "verify-mask-preview.mjs",
  "verify-mask-output.mjs",
  "verify-mask-tabs.mjs",
  "verify-mask-gallery.mjs",
  "verify-masks.mjs",
  "verify-gallery-capture.mjs",
  "verify-era-e2e.mjs",
  "verify-doodle-burn.mjs",
  "verify-sticker-edit.mjs"
)
$totalPass = 0
$totalFail = 0
$bad = @()
foreach ($s in $scripts) {
  if (-not (Test-Path $s)) { "SKIP  $s (not found)"; continue }
  $out = node $s 2>&1 | Out-String
  $clean = ($out -split "`r?`n") | Where-Object { $_ -notmatch "DXCache|NVIDIA\(|TRAE Sandbox|Hint:|Not allow|Alternatively,|configure sandbox" }
  $sum = @(($clean | Where-Object { $_ -match "结果:|Result:|=> PASS|=> FAIL" } | Select-Object -Last 1))
  $sumTxt = if ($sum.Count -gt 0) { [string]$sum[0] } else { "(no summary)" }
  $p = 0; $f = 0
  if ($sumTxt -match "(\d+)\s*(?:通过|passed)") { $p = [int]$Matches[1] }
  if ($sumTxt -match "(\d+)\s*(?:失败|failed)") { $f = [int]$Matches[1] }
  if ($sumTxt -match "=> FAIL" -or $f -gt 0) { $bad += $s }
  $totalPass += $p; $totalFail += $f
  "{0,-30} {1}" -f $s, ($sumTxt -replace "\s+", " ").Trim()
}
""
"================================"
" TOTAL: $totalPass passed, $totalFail failed"
if ($bad.Count -gt 0) { " FAILED SCRIPTS: $($bad -join ', ')" } else { " ALL GREEN" }
