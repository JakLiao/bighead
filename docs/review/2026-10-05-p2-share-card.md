# P2 拼图落盘 + 分享卡 / 清遗留 实施记录

- **分支**：`feature/p2-share-card`
- **计划**：[docs/superpowers/plans/2026-10-05-p2-share-card.md](file:///f:/Trae-work/bighead/docs/superpowers/plans/2026-10-05-p2-share-card.md)
- **上一阶段**：[P1 记录](file:///f:/Trae-work/bighead/docs/review/2026-10-05-p1-album-and-retake.md)

---

## 一句话交付

**拼图第一次真正落盘。** 此前默认路径（非 AI）拍完的拼图只存在于浏览器内存的 blob 里，刷新即消失、贴纸册里永远不出现。P2 补上了这条从未存在的链路，并在其上生成了固定 4:3 的分享卡 `share.jpg`。

---

## 三个关键发现（决定了计划范围）

这三项都不是原计划里写的，是扫描阶段发现的。它们把「加个保存按钮」变成了「补一条链路」。

### 1. 非 AI 路径的拼图 100% 不落盘

原 [DecoratePage.doLayout](../frontend/src/pages/DecoratePage.tsx)：

```tsx
const result = await makeLayout(finalBlobs, layout, frameOverride ?? "none");
setLayoutUrl(URL.createObjectURL(result));   // 纯内存 blob
```

`/api/layout/make` 把 `collage_to_bytes` 的结果直接 `Response` 回去了，磁盘上没有任何写入——没有 `saveCaptures`，没有 `job_id`，没有目录。

**后果**：默认路径（`aiEnabled=false`）的拼图刷新页面即消失，贴纸册里永远不会出现这一条。下载按钮拿到的也是 `blob:` 路径，文件名毫无意义。

### 2. AI 路径落了盘，但贴纸册看不见

AI 路径写的是 `outputs/{job_id}/ai/{style}/layout.jpg`，而 `gallery.py` 只探测顶层 `layout.jpg`，**不递归进 `ai/`**。于是那张拼图在贴纸册里只以 4 张单图缩略图出现，拼图本身从不展示。

### 3. `LAYOUT_FILENAME` 是死常量

`config.py` 定义了它，但 `build_ai_layout` 与 `gallery` 各自硬编码字符串。本次把三处全部接到常量上，避免下次改名漏改。

---

## 三项决策（已与用户确认）

| 决策 | 结论 |
|---|---|
| 落点 | 两条路径统一产出顶层 `outputs/{job_id}/layout.jpg` |
| 分享卡文件名 | `share.jpg`，与 `layout.jpg` 平级 |
| 中文字体 | 微软雅黑 `msyh.ttc` |

---

## 交付内容

### 后端

| 文件 | 状态 | 责任 |
|---|---|---|
| `backend/share_card.py` | 新增 | 4:3 分享卡合成（纯 PIL）：等比 contain + 居中 + footer |
| `backend/routes/share.py` | 新增 | `POST /api/share/save`：16MB 上限 + Pillow 实解码校验 |
| `backend/routes/layout.py` | 修改 | `layout_make` 新增可选 `job_id`；新增 `_resolve_job_id_or_404` |
| `backend/routes/gallery.py` | 修改 | `_pick_thumb` / `_matches` / `_same_content` / q·tag 筛选 / tags 汇总 |
| `backend/config.py` | 修改 | `SHARE_FILENAME` + 分享卡几何/字体常量 |
| `backend/pipeline.py` | 修改 | `_mirror_layout_to_top`：AI 拼图复制到 job 顶层 |
| `backend/app.py` | 修改 | 注册 share router |
| `backend/scripts/verify_share_card.py` | 新增 | 44 项断言 |

### 前端

| 文件 | 状态 | 责任 |
|---|---|---|
| `frontend/src/shareCard.ts` | 新增 | 浏览器端 4:3 卡片合成（与后端镜像对应） |
| `frontend/src/components/album/useEscape.ts` | 新增 | Escape 关闭 hook |
| `frontend/src/api.ts` | 修改 | `saveShareCard`；`fetchGallery` 支持 q/tag |
| `frontend/src/types.ts` | 修改 | `TagCount` / `AlbumPatchResult` / `ShareSaveResult` |
| `frontend/src/store.ts` | 修改 | `shareUrl` 状态 |
| `frontend/src/pages/DecoratePage.tsx` | 修改 | `makeLayoutToJob`；非 AI 三步落盘；AI 两条分支生成分享卡；分享卡 UI |
| `frontend/src/pages/GalleryPage.tsx` | 修改 | 搜索框 + 标签筛选条；reload 按当前筛选重拉 |
| `frontend/src/components/album/AlbumEditor.tsx` | 修改 | `dirty` 逐位比较 + 保存置灰 + Escape |

### 验证

| 文件 | 状态 | 覆盖 |
|---|---|---|
| `frontend/verify-share-card.mjs` | 新增 | 20 项：落盘、4:3 几何、非法输入拒绝、刷新后仍可访问 |
| `frontend/verify-album-search.mjs` | 新增 | 35 项：q/tag 筛选、no-op、置灰、Escape |
| `frontend/maskBurstHelper.mjs` | 新增 | RetakeBar 推进（修 P1 遗留的三个脚本） |
| `frontend/run-all-verify.ps1` | 修改 | 加入 2 个新脚本 + **崩溃检测** |

---

## 实现过程中发现并修复的问题

### 1. 自造的真值判断 bug（`captured_at=0.0`）

`share_card.py` 初版写 `if captured_at:`，`0.0` 被判假 → 回落到「今天」。表现是日期悄悄错了、**无任何报错**。

这正是我在计划里批评 P1 `_same_content` 时说的那类陷阱，自己在新代码里又犯了一次。改为 `if captured_at is not None`。

### 2. tags 未做集合规范化，会让 no-op 拦截失效

`verify_share_card.py` 有两条断言红了：

```
[FAIL] q 大小写不敏感
[FAIL] _same_content 对 tags 顺序敏感
```

第一条是**测试写错**（`_matches` 的 `lower()` 原先放在调用方，绕过它就失效）——但这暴露了隐式契约，已把 `lower()` 移进函数内让契约自洽。

第二条查证后确认是**真设计缺口**：`["旅行","2026"]` 与 `["2026","旅行"]` 对用户是同一件事，但顺序不同会被判为「有变化」→ 重新引入 no-op 噪音。修法是在 `_normalize_entry` 加去重 + 排序，顺带清掉了 P1 遗留第 1 条（标签去重只在前端）的后端缺口。

### 3. 三个 mask 脚本是红的（P1 遗留回归）

`run-all-verify` 第一轮显示三个 `(no summary)`。我先按「汇总脚本的解析局限」接受了，**这是错的**——单独跑才看到 `TimeoutError`。

真实原因：P1 引入 RetakeBar 暂停后，所有「按空格等 `frames.length >= 4`」的脚本会永远停在 1/4。P1 只适配了 `verify-burst.mjs`，三个 mask 脚本被漏掉。

修法：抽出 `maskBurstHelper.mjs` 提供 `burstTo()`，三处统一调用。

### 4. 汇总脚本把崩溃伪装成「格式不匹配」

这是最值得记的一条。`run-all-verify.ps1` 只从「最后一行的汇总文本」解析数字，脚本崩溃时根本没走到打印汇总那步，于是显示 `(no summary)` 而非失败，退出码被丢弃。**结果就是「三个真回归」被汇总成 `ALL GREEN`。**

已加崩溃检测（`TimeoutError|ReferenceError|TypeError|...` + 退出码），崩溃时至少记 1 个失败。这条不是洁癖，是修一个会持续骗人的缺陷。

### 5. 三个测试期望写错（不是实现 bug）

`verify-album-search.mjs` 首轮 3 红：

| 失败 | 真相 |
|---|---|
| `标签顺序不同算 no-op` | jidB 原本 `["生活"]`，我传 `["生活","旅行"]` 是真新增标签，`changed=true` 正确 |
| `局部 PATCH 不清空 favorite` | favorite 只在 jidA 设过，jidB 本来就是 false |
| `按标签筛选后只剩 1 条` | 上一项的测试污染 |

外加一个 `TimeoutError`：`page.locator("input").first()` 命中的是页面**搜索框**而非抽屉标题框。已加 `data-album-title` 精确定位。

**教训**：测试写错和实现有 bug 的表现完全一样（都是红）。必须逐个查证是「代码错」还是「断言错」，不能看到红就改实现。

---

## 验证结果

### 后端自测

```powershell
& "E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe" backend\scripts\verify_share_card.py
# 结果: 44 通过, 0 失败 / ALL GREEN

& "E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe" backend\scripts\verify_album_meta.py
# Result: 25 passed, 0 failed
```

### 全量 E2E

```
verify-camera.mjs              PASS: 7 FAIL: 0
verify-burst.mjs               => PASS 连拍完成
verify-mask-preview.mjs        结果: 14 通过, 0 失败
verify-mask-output.mjs         结果: 37 通过, 0 失败
verify-mask-tabs.mjs           结果: 21 通过, 0 失败
verify-mask-gallery.mjs        结果: 31 通过, 0 失败
verify-masks.mjs               结果: 22 通过, 0 失败
verify-gallery-capture.mjs     结果: 11 通过, 0 失败
verify-era-e2e.mjs             Result: 19 passed, 0 failed
verify-doodle-burn.mjs         Result: 58 passed, 0 failed
verify-sticker-edit.mjs        Result: 69 passed, 0 failed
verify-album-meta.mjs          Result: 30 passed, 0 failed
verify-album-edit.mjs          Result: 22 passed, 0 failed
verify-retake-bar.mjs          Result: 20 passed, 0 failed
verify-share-card.mjs          Result: 20 passed, 0 failed
verify-album-search.mjs        Result: 35 passed, 0 failed
================================
 TOTAL: 416 passed, 0 failed
 ALL GREEN
```

P1 时期是 225（且有 6 个 `(no summary)`），现在 416 且**每个脚本都有明确汇总行**。

### 静态门禁

| 门禁 | 结果 |
|---|---|
| `ruff check backend scripts` | All checks passed |
| `python -m compileall -q backend scripts` | OK |
| `npm run typecheck` | 无错误 |
| `npm run lint` | 0 errors, 2 warnings（均为既有代码） |

---

## 设计要点

### 分享卡两份实现

| 位置 | 用途 |
|---|---|
| `frontend/src/shareCard.ts` | 正常出片（本地 canvas，零往返） |
| `backend/share_card.py` | 补生成历史卡片（无前端上下文时） |

几何常量逐值对应（1200×900 / margin 40 / footer 220）。**不一致时只有肉眼能发现**，两处注释互相点名。

### 为什么 `/api/share/save` 接收前端合成好的卡片

而不是让后端从原始拼图合成：正常出片时前端已持有 collage blob 与 job_id，走服务端意味着几 MB 上传 + 合成 + 下载的双向往返。后端的实现只服务「补生成历史卡片」这类没有前端上下文的场景。

### 落盘路径统一

```
非 AI:  saveCaptures → job 目录 + photo_N.jpg
        makeLayout(job_id) → layout.jpg
        renderShareCard + saveShareCard → share.jpg

AI:    capture/save → job 目录 + photo_N.jpg
        build_ai_layout → ai/{style}/layout.jpg
        _mirror_layout_to_top → layout.jpg（顶层副本）
        前端抓顶层 layout.jpg → 合成 share.jpg
```

`_mirror_layout_to_top` 让 `gallery` 的非递归探测对两条路径都生效——一处探测覆盖全局。

### no-op PATCH 双层拦截

| 层 | 作用 |
|---|---|
| 后端 `_same_content` | 数据正确性：无变化不写盘，返回 `changed: false` |
| 前端 `dirty` 置灰 | 交互反馈：用户立刻知道「没什么可保存」 |

`tags` 必须**逐位**比较而不是 `!==`——数组每次渲染都是新引用，直接比会恒为「有变化」，置灰逻辑等于不存在。

---

## 明确不在本次范围

- 二维码（用户明确排除）
- `/share/{job_id}` 公开分享页
- 邮件投递
- 道具/配饰图层
- 视频 / GIF 导出
- 原生打印对接
- 搜索 debounce（取舍理由见 `api.ts` 注释）

## 剩余遗留

### 原 P1 清单 — 已全部清完

| 遗留 | 状态 |
|---|---|
| 清空所有条目后 `_album.json` 残留空文件 | ✅ 已清（见下方复核 §2） |
| 无 `prefers-reduced-motion` | ✅ 已清（见下方复核 §3） |
| 损坏的元数据备份不自动清理 | ✅ 已清（见下方复核 §2） |
| 标签去重只在前端 | ✅ P2 已在后端补齐 |
| no-op PATCH 仍更新 `updated_at` | ✅ P2 已拦截 |
| 无搜索/筛选 | ✅ P2 已实现 |
| Escape 不关闭贴纸册编辑器 | ✅ P2 已实现 |

### 复核后仍存在

1. **AI 路径的顶层 `layout.jpg` 占双份磁盘**（`ai/{style}/` 与顶层内容相同，约 1–2MB）。
2. **搜索无 debounce**——数十条数据无感，条目上千时需要重抽。
3. **2 个 lint warning 仍在**（`AlbumEditor` / `GalleryPage` 的 effect 内同步 setState）。属 React 18 下的可接受写法：状态重置需要在 `initial` 变化时发生，改成异步会引入一帧的旧值。已确认不是本次引入。

---

## P2 交付后的复核（2026-10-06）

P2 提交后做了一轮回查，发现 **4 个问题**（1 个测试盲点 + 2 个静默失败 + P1 遗留三项），全部已修。

### 复核 §1：UI 出片链路从未被 e2e 跑过（测试盲点）

`verify-share-card.mjs` 全部是**直接打 API**，而 P2 真正的新逻辑在 [DecoratePage.doLayout](../frontend/src/pages/DecoratePage.tsx) 里：

```
saveCaptures → makeLayoutToJob → renderShareCard → saveShareCard
```

纯 API 测试**完全绕过了**这一段。而且这三个点都会静默出错：

| 出错方式 | 页面表现 |
|---|---|
| 忘传 `job_id` | 照常出图（服务端不落盘是设计如此） |
| `layoutUrl` 仍是 `blob:` | 页面上能看，刷新就消失 |
| `saveShareCard` 传错 job | 分享卡落到别的 job，本轮没有卡 |

唯一可靠的判据是**去磁盘上核对**。

新增 [verify-decorate-persist.mjs](../frontend/verify-decorate-persist.mjs)（22 项）：走完整 UI 流程（拍摄 → 出片 → 落盘），然后直接读 `outputs/{job_id}/` 下的文件核对尺寸与存在性。

实测结果：`layout.jpg` 1320×1800、`share.jpg` 严格 1200×900、4 张 `photo_N.jpg` 均落盘、贴纸册缩略图优先 `share.jpg`、刷新后仍可访问。

**教训**：「API 层测试通过」不等于「用户路径可用」。凡是有多步编排的链路，测试必须走完整个编排，否则中间任何一步接错都测不出来。

### 复核 §2：静默失败 #1 — 字体全缺失时 footer 空白且无告警

复现：把字体候选链全部指向不存在的路径，`render_share_card` 仍输出一张**尺寸完全正确**的 4:3 卡片，只是 footer 一片空白。

如果没有这条日志，这种卡会被当成生成成功——它确实「成功」了，只是没有文字，而这种退化在生产上几乎不可能被肉眼发现（每张卡都缺 footer）。

修法：`_load_font` 在候选链全挂时 `log.warning` 一次（**不抛异常**——抛异常会让补生成路径整条挂掉）。

### 复核 §3：静默失败 #2 — 画布合成失败会产出「假分享卡」

`renderShareCard` 原实现在 `getContext` 失败或 `toBlob` 返回 null 时**回落到原拼图**。于是会产生一张：

> 文件名叫 `share.jpg`、内容其实是原始拼图的东西

它看起来完全正常，只是缺了 4:3 卡框和 footer——属于典型的静默错误产物。

修法：改为返回 `null`，三处调用点显式处理（合成失败只是这一轮没有卡，拼图本身已落盘可用）。

### 复核 §4：P1 遗留三项

| 项 | 修法 |
|---|---|
| `_album.json` 空残留 | `_save_album` 在 `album` 为空时 `unlink` 而非写 `{}`——空文件与「文件不存在」对读端是同一含义 |
| 损坏备份堆积 | 新增 `_prune_broken_backups`，写盘时保留最近 3 个、删掉更旧的 |
| 无 `prefers-reduced-motion` | `index.css` 加 `@media` 块覆盖全部 4 个动画类 |

`prefers-reduced-motion` 的降级策略是「去动画、保终态」而不是 `display:none`：倒计时数字（`.countdown-num`）与 pose 提示都靠动画结束后的 `opacity:1` 呈现，直接隐藏会让用户彻底看不到倒计时。

### 复核 §5：把「自觉」变成门禁

P2 计划里我写过一句「前后端几何常量不一致时只有肉眼能发现」。复核时认为这话不该接受——两边都是纯数字字面量，机器完全可以读前端源码比对。

`verify_share_card.py` 新增 8 项断言：用正则读 `frontend/src/shareCard.ts`，比对 5 个数值常量 + 品牌文案 + `shortJobId` 是否复用常量。

**做了变异验证**（把前端 `900` 改成 `888` → 断言变红；还原 → 变绿），证明它真的有牙齿而非恒为真。断言恒为真的门禁比没有门禁更危险——它给人虚假的安全感。

### 复核 §6：又一次「测试红 ≠ 实现错」

`_album.json` 清理的测试首轮 2 红，逐个查证：

| 失败 | 真相 |
|---|---|
| `元数据清空时备份也清掉` | 我的断言写错——`_prune` 语义是「保留最近 3 个」不是「清空目录」 |
| `坏 JSON 被备份`（计数 2≠1） | 测试用假序号 `broken-1000..1004` 造备份，与真实时间戳命名混排，验证了一个不会发生的场景 |

第二次仍然错：`_prune` 按 mtime 排序，我用人工序号验证排序本身就不成立。改成用真实时间戳命名后通过。

另外 `ruff` 抓到我在同一批改动里写的 `logging as _logging` 与 `logging` 混用（`F821 Undefined name`），已统一。

### 复核后验证结果

```
TOTAL: 445 passed, 0 failed   (18 个脚本)
ALL GREEN
```

后端自测 67 项（复核前 44），既有 `verify_album_meta.py` 25 项无回归。新增两个脚本：`verify-decorate-persist.mjs`(22)、`verify-reduced-motion.mjs`(7)。

`verify-reduced-motion.mjs` 用 computed style 而非截图验证：截图只能证明「看起来没动」，证明不了 `animation` 属性真被置为 `none`；更要防的是「新加动画类时忘了加进降级名单」——那种回归在截图里几乎看不出来，但会让本脚本变红。

---

## 本地验证命令

```powershell
# 依赖预检（必须先跑，用错解释器只有点 AI 生成才报错）
& "E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe" -c "import sys; from backend.peft_compat import ensure_peft; import insightface, onnxruntime, diffusers, transformers, torch, fastapi, uvicorn; assert ensure_peft(), 'peft still broken'; print('PY=', sys.executable); print('OK')"

# 后端 8077
& "E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe" -m uvicorn backend.app:app --host 127.0.0.1 --port 8077

# 前端 5173（必须显式指明后端地址）
cd frontend
$env:BIGHEAD_API_TARGET="http://127.0.0.1:8077"
npm run dev

# 全量回归
cd frontend
.\run-all-verify.ps1
```
