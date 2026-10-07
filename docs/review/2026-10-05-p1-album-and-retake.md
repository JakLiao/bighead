# P1 实施记录：贴纸册 + pose 引导 / 单张重拍

- **分支**: `feature/p1-album-and-retake`
- **计划**: [`docs/superpowers/plans/2026-10-05-p1-album-and-retake.md`](../superpowers/plans/2026-10-05-p1-album-and-retake.md)
- **执行方式**: subagent-driven-development（每 Task 一个实现者子代理 + spec 评审 + 代码质量评审）
- **日期**: 2026-10-05

---

## 1. 交付内容

落地竞品分析第 3.4、3.5 节的两项 P1 能力：

| 能力 | 交付物 |
|---|---|
| **贴纸册** | `outputs/_album.json` sidecar 元数据 + `PATCH`/`DELETE /api/gallery/{job_id}` + 卡片化画廊 + 编辑抽屉（标题/备注/标签/收藏/删除） |
| **pose 引导** | 4 词循环文字浮层（嘟嘴/比心/看镜头/笑僵）+ 可开关 `showPose` |
| **单张重拍** | 前 3 张拍完插入「重拍本张 / 继续」暂停条，新片插回原位置 |

---

## 2. 改动文件清单

### 后端
| 文件 | 变更 |
|---|---|
| [backend/config.py](file:///f:/Trae-work/bighead/backend/config.py) | 新增 `ALBUM_FILENAME` + 4 个 `ALBUM_MAX_*` 上限常量 |
| [backend/routes/gallery.py](file:///f:/Trae-work/bighead/backend/routes/gallery.py) | 41 行 → 196 行：sidecar 元数据层 + GET 合并 + PATCH/DELETE 路由 |
| [backend/scripts/verify_album_meta.py](file:///f:/Trae-work/bighead/backend/scripts/verify_album_meta.py) | 新增：25 项裸 assert 自测 |

### 前端
| 文件 | 变更 |
|---|---|
| [frontend/src/types.ts](file:///f:/Trae-work/bighead/frontend/src/types.ts) | 新增 `AlbumEntry` / `GalleryItem` / `GalleryResponse` |
| [frontend/src/api.ts](file:///f:/Trae-work/bighead/frontend/src/api.ts) | `fetchGallery` 返回类型改用 `GalleryResponse`；新增 `patchAlbum` / `deleteAlbum` |
| [frontend/src/store.ts](file:///f:/Trae-work/bighead/frontend/src/store.ts) | 新增 `showPose` + `setShowPose`（**不进 `reset()`**，与 `showGuides` 同为 UI 偏好） |
| [frontend/src/pages/HomePage.tsx](file:///f:/Trae-work/bighead/frontend/src/pages/HomePage.tsx) | `doSnap` 改写为「前 3 张暂停、第 4 张直通」+ `insertAtRef` 插回 + `handleRetakePick` + pose 浮层 + 开关 |
| [frontend/src/pages/GalleryPage.tsx](file:///f:/Trae-work/bighead/frontend/src/pages/GalleryPage.tsx) | 整体改写为贴纸册：卡片 + 收藏徽标 + 编辑抽屉挂载 |
| [frontend/src/components/album/AlbumEditor.tsx](file:///f:/Trae-work/bighead/frontend/src/components/album/AlbumEditor.tsx) | 新增：编辑抽屉（含 `MAX_*` 常量与 `data-testid`） |
| [frontend/src/components/retake/PoseHint.tsx](file:///f:/Trae-work/bighead/frontend/src/components/retake/PoseHint.tsx) | 新增：pose 文字浮层 |
| [frontend/src/components/retake/RetakeBar.tsx](file:///f:/Trae-work/bighead/frontend/src/components/retake/RetakeBar.tsx) | 新增：重拍确认条 |
| [frontend/src/index.css](file:///f:/Trae-work/bighead/frontend/src/index.css) | 新增 `@keyframes pose-in` + `.animate-pose-in` |

### 测试
| 文件 | 变更 |
|---|---|
| [frontend/verify-album-meta.mjs](file:///f:/Trae-work/bighead/frontend/verify-album-meta.mjs) | 新增：30 项（PATCH/GET/排序/路径穿越/DELETE） |
| [frontend/verify-album-edit.mjs](file:///f:/Trae-work/bighead/frontend/verify-album-edit.mjs) | 新增：22 项（徽标/抽屉/标签/收藏/两段式删除） |
| [frontend/verify-retake-bar.mjs](file:///f:/Trae-work/bighead/frontend/verify-retake-bar.mjs) | 新增：20 项（pose 循环/开关/暂停/重拍/直通） |
| [frontend/verify-burst.mjs](file:///f:/Trae-work/bighead/frontend/verify-burst.mjs) | **改造**：适配 RetakeBar 暂停（原脚本假设自动推进） |
| [frontend/run-all-verify.ps1](file:///f:/Trae-work/bighead/frontend/run-all-verify.ps1) | 新增：14 脚本一键汇总 |

**未触碰**：`CountdownOverlay.tsx`、`LiveCamera.tsx`、`renderMask.ts`、`backend/filters.py`、`backend/routes/capture.py`、`backend/routes/preview.py`。**无新依赖**。

---

## 3. 验证结果

### 门禁
```
ruff check backend scripts     → All checks passed!
compileall -q backend scripts   → OK
tsc -b --force                 → 0 errors
eslint src                      → 0 errors, 1 warning（AlbumEditor 的
                                 set-state-in-effect，切换 item 重置表单，
                                 属合理用法）
```

### 断言统计
| 层 | 脚本 | 结果 |
|---|---|---|
| 后端纯函数 | `verify_album_meta.py` | **25 / 25** |
| 前端 e2e | `verify-album-meta.mjs` | **30 / 30** |
| 前端 e2e | `verify-album-edit.mjs` | **22 / 22** |
| 前端 e2e | `verify-retake-bar.mjs` | **20 / 20** |
| 前端 e2e | `verify-burst.mjs` | PASS（RetakeBar 暂停恰好 3 次 + 第 4 张直通） |
| **全量 14 脚本** | `run-all-verify.ps1` | **225 passed / 0 failed — ALL GREEN** |

---

## 4. 评审发现与修复

subagent-driven 流程的价值在这次得到了具体体现——**三个真实问题都是在评审环节抓到的，不是靠测试**。

### 4.1 计划自身的 bug（实现者发现）
计划 Step 1.4 的 `_merge_entry` 用 `nxt.items()` 覆盖全部字段，而 `_normalize_entry` 永远返回完整 5 字段（含空串/空列表缺省）。结果：PATCH 只传 `title` 会把 `note`/`tags` 抹空。

**修复**：改用 `set(patch.keys())` 限制覆盖范围。计划 Step 1.2 的自测断言「合并后 note 保留」「合并后 tags 保留」立刻暴露了此 bug——修复后与自测语义自洽。

### 4.2 Critical：元数据不可逆丢失（代码质量评审）
`_load_album` 在 `JSONDecodeError` 时 `return {}`，下次 `_save_album` 会写入 `{}` **永久覆盖**原始元数据。

**修复**：`JSONDecodeError` 时 `os.replace` 到 `_album.json.broken-{ts}` 备份再返回 `{}`；`OSError` 单独 catch 不备份（IO 抖动不等于文件损坏）。补 3 项回归测试。

### 4.3 Important：重拍后新片跑到末尾（代码质量评审）
`doSnap` 只做 `[...frames, new]`，重拍 idx=0 后新片落到第 3 格而非第 1 格——明显 UX bug，与计划「插回 retakeIdx」的措辞不符。

**修复**：引入 `insertAtRef`（`useRef<number \| null>`）。`handleRetakePick` 写 `insertAtRef.current = retakeIdx`，`doSnap` 读到后用 `slice + 插入 + slice` 重组并立刻清空 ref。

### 4.4 Important：`_JOB_ID_RE` 漏拒 `_` 开头（代码质量评审）
regex 允许 `_xxx`，但 GET 跳过 `_` 开头目录 → PATCH/DELETE 能改前端看不到的条目。

**修复**：收紧为 `^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$`。补 1 项负向回归。

### 4.5 Important：`startCapture` 未显式清 `retakeIdx`（代码质量评审）
原先只靠「`capturing` 与 `retakeIdx` 同步」的隐式不变式维持，脆弱。

**修复**：`startCapture` 顶部加 `setRetakeIdx(null)`，把隐式约束提升为显式重置。

### 4.6 pose 索引语义（Task 6 端到端验证发现）
我在 Task 4 修复评审时把索引改成 `retakeIdx ?? frames.length`，理由是「重拍时保持该张的词」。端到端跑起来后暴露出这语义不对：用户在 RetakeBar 犹豫时看到的应是**下一张要摆的姿势**，而不是已拍过那张的。

**修复**：回退为 `POSES[frames.length % POSES.length]`。推理验证：重拍时 `frames.filter` 先把长度从 N 减到 N-1，`insertAt` 让 `doSnap` 插回原位，所以重拍完成后 `frames.length === idx`，索引天然指向「即将拍的第 idx+1 张」——无需 `retakeIdx`。同步修正了 5 条断言的语义。

### 4.7 Minor 清理
- `PoseHint` JSDoc 提到 `useEffect` 但代码未用（`key` remount 即可）→ 改写注释
- `AlbumEditor` 的 `MAX_*` 魔法数字 → 提取为模块级常量并注明与后端同步
- `GalleryPage` 的 `alive` 标志是死代码（`.then()` 里什么都不做）→ 改为标准 `cancelled` 取消模式
- 标签 chip 与 `★` 徽标的 e2e 选择器用精确文本匹配失败（chip 内嵌删除按钮）→ 改用 `hasText`

---

## 5. 与计划的偏离

| 项 | 计划 | 实际 | 原因 |
|---|---|---|---|
| `verify-burst.mjs` | 跑齐 8 脚本即可 | **必须改造** | P1 引入 RetakeBar 暂停后，连拍不再自动推进。原脚本假设「第 1 张拍完自动进第 2 张」，不改必然 FAIL。这是计划未预见的行为变更，非回归。改造后同时验证了「暂停恰好 3 次 + 第 4 张直通」 |
| 后端自测数量 | 约 20 项 | **25 项** | 评审要求补 DELETE 端到端与 C1 损坏备份验证 |
| pose 索引 | `frames.length` | `frames.length`（中途改过又回退） | 见 4.6 |
| `AlbumEditor` 标签 input | 计划含 `maxLength` | 只有 `onChange` slice | `slice` 优于 `maxLength`（后者按 UTF-16 码元截，中文/emoji 易被截半） |

---

## 6. 已知遗留

1. **标签去重仅在前端做**（`addTag` 的 `tags.includes`）。后端不校验重复，绕过前端直接调 API 可写入重复标签。
2. **无搜索 / 筛选**。79 条记录后需要翻页才能找到特定条目，贴纸册的核心价值（收集整理）打了折扣。
3. **删完后 `_album.json` 不会瘦身为空文件**。删光所有条目后文件留存 `{}`，功能无影响。
4. **无 `prefers-reduced-motion` 兼容**。`.animate-pose-in` 与既有的 `shutter-flash` / `countdown-pop` 都没做，P1 未单独引入此债。
5. **Escape 键不关闭编辑抽屉**。桌面端习惯按 Esc 关模态，当前只能点遮罩或取消。
6. **保存不阻断无变化 PATCH**。点开抽屉直接点保存也会发一次请求并 bump `updated_at`，导致未改动的条目在倒序里前移。
7. **`_album.json.broken-*` 不会自动清理**。损坏时备份的文件会一直留在 `outputs/`（这正是保留它的目的，但需人工清理）。

---

## 7. 提交链

```
815da09  docs(plan): P1 贴纸册 + pose 引导 / 单张重拍实施计划
cfa3945  feat(album): _album.json sidecar + PATCH/DELETE /api/gallery/{job_id}
7cd7a90  fix(album): 备份损坏 _album.json、禁止 _ 开头 job_id、补 DELETE/C1 测试
1b5be17  feat(album): AlbumEntry/GalleryItem types + patchAlbum/deleteAlbum API
e19fd12  feat(retake): PoseHint + RetakeBar UI 组件
1e3f0ab  docs(retake): PoseHint JSDoc 修正 (key remount 而非 useEffect)
3a4f3f3  feat(retake): pose 浮层 + RetakeBar 暂停条 + 单张重拍
475ed9a  fix(retake): 重拍插回原位置 + startCapture 清 retakeIdx + pose 索引跟 retakeIdx
fcda9fd  feat(album): GalleryPage 贴纸册化 + AlbumEditor 编辑抽屉
66ab87e  refactor(album): 提取 MAX_* 常量 + data-testid/data-job-id 便于 e2e
cbe1e88  test(burst): 适配 P1 RetakeBar 暂停 + 新增全量回归汇总脚本
c9a9671  test(p1): album-meta/album-edit/retake-bar 三个 e2e + pose 索引回退 frames.length
```

---

## 8. 本地验证方式

```powershell
# 依赖预检（必须用 webui venv）
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" -c "import sys; from backend.peft_compat import ensure_peft; import insightface, onnxruntime, diffusers, transformers, torch, fastapi, uvicorn; assert ensure_peft(), 'peft still broken'; print('PY=', sys.executable); print('OK')"

# 后端 8077
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" -m uvicorn backend.app:app --host 127.0.0.1 --port 8077

# 前端 5173（沙箱内需把 npm 缓存指到项目内，否则 Node 写 E:\nodejs\node_cache\_logs 会被拦）
cd frontend
$env:NPM_CONFIG_CACHE="f:\Trae-work\bighead\.npm-cache"
$env:BIGHEAD_API_TARGET="http://127.0.0.1:8077"
npm run dev

# 全量回归
cd frontend
powershell -NoProfile -ExecutionPolicy Bypass -File .\run-all-verify.ps1
```

**沙箱注意事项**：`Stop-Process` / `node` 等命令若与服务共用终端，会把后台的 uvicorn 与 vite 一并杀掉。所有验证命令请用独立终端执行。
