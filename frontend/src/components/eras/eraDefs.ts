import type { EraKey } from "../../types";

/**
 * 年代预设的展示信息。
 *
 * key 集合必须与后端 `backend/config.py` 的 `ERA_PRESETS` 一致 ——
 * 后端是唯一权威, /api/meta 的 era_presets 会覆盖这里(见 DecoratePage)。
 * 这份常量只作首屏兜底: 在 meta 到达之前也能立刻渲染出可用的开关,
 * 避免闪一下空面板。
 */
export interface EraDef {
  key: EraKey;
  name: string;
  desc: string;
}

export const ERA_DEFS: EraDef[] = [
  { key: "modern", name: "现代高清", desc: "保持原画质, 不做退化" },
  { key: "vintage_2000", name: "古早画质", desc: "低分辨率 + 顶部漏光 + 色阶断层" },
];

/** 默认年代。必须与后端 ERA_DEFAULT 一致, 否则首帧会闪一下 vintage 再跳回 modern。 */
export const ERA_DEFAULT: EraKey = "modern";
