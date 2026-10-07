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
  "verify-sticker-edit.mjs",
  "verify-album-meta.mjs",
  "verify-album-edit.mjs",
  "verify-gallery-paging.mjs",
  "verify-gallery-trash.mjs",
  "verify-gallery-marquee.mjs",
  "verify-gallery-selection.mjs",
  "verify-retake-bar.mjs",
  "verify-share-card.mjs",
  "verify-album-search.mjs",
  "verify-decorate-persist.mjs",
  "verify-reduced-motion.mjs"
)
$totalPass = 0
$totalFail = 0
$bad = @()
foreach ($s in $scripts) {
  if (-not (Test-Path $s)) { "SKIP  $s (not found)"; continue }
  $out = node $s 2>&1 | Out-String
  $clean = ($out -split "`r?`n") | Where-Object { $_ -notmatch "DXCache|NVIDIA\(|TRAE Sandbox|Hint:|Not allow|Alternatively,|configure sandbox" }
  $sum = @(($clean | Where-Object { $_ -match "结果|Result|PASS:|FAIL:|=> PASS|=> FAIL" } | Select-Object -Last 1))
  $sumTxt = if ($sum.Count -gt 0) { [string]$sum[0] } else { "(no summary)" }
  $p = 0; $f = 0
  # 兼容两种汇总格式:
  #   "Result: 30 passed, 0 failed" / "结果: 22 通过, 0 失败"
  #   "PASS: 7   FAIL: 0"
  if ($sumTxt -match "PASS:\s*(\d+)\s+FAIL:\s*(\d+)") {
    $p = [int]$Matches[1]; $f = [int]$Matches[2]
  } else {
    if ($sumTxt -match "(\d+)\s*(?:通过|passed)") { $p = [int]$Matches[1] }
    if ($sumTxt -match "(\d+)\s*(?:失败|failed)") { $f = [int]$Matches[1] }
  }
  # 崩溃检测 —— 这一段是 P2 补的, 不是洁癖。
  #
  # 早先这里只从"最后一行的汇总文本"里解析数字, 于是**崩溃的脚本会被显示成
  # (no summary) 而不是失败**: node 抛异常时根本没走到打印汇总那步, 退出码
  # 非 0 但被丢弃。结果 P1 引入 RetakeBar 暂停后, 三个 mask 脚本全部
  # TimeoutError, 汇总却显示 "ALL GREEN" —— 一条真回归被"格式不匹配"
  # 伪装成了"环境问题"。现在显式看退出码与异常特征。
  $crashed = $out -match "TimeoutError|ReferenceError|TypeError|SyntaxError|UnhandledPromiseRejection|ERR_MODULE|throw new Error"
  if ($crashed -or $LASTEXITCODE -ne 0) {
    if ($f -eq 0) { $f = 1 }   # 崩溃时至少记 1 个失败, 不让总数虚报 0
    $bad += $s
    if ($sumTxt -eq "(no summary)") {
      $sumTxt = "CRASHED (exit=$LASTEXITCODE)"
    } else {
      $sumTxt = "$sumTxt  ** CRASHED **"
    }
  }
  if ($sumTxt -match "=> FAIL" -or $f -gt 0) { if ($bad -notcontains $s) { $bad += $s } }
  $totalPass += $p; $totalFail += $f
  "{0,-30} {1}" -f $s, ($sumTxt -replace "\s+", " ").Trim()
}
""
"================================"
" TOTAL: $totalPass passed, $totalFail failed"
if ($bad.Count -gt 0) { " FAILED SCRIPTS: $($bad -join ', ')" } else { " ALL GREEN" }
