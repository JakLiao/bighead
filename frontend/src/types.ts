export type StyleKey = "PORTRAIT_HK" | "FILM_VELVIA" | "SHOWA_ANIME" | "DARKROOM_STICKER";
export type FilterKey =
  | "none"
  | "faded_90s"
  | "warm_kodak"
  | "bw_classic"
  | "vhs"
  | "polaroid"
  | "vintage_korean";
export type FrameKey = "none" | "plain_white" | "korean_pink" | "polaroid" | "checker";
export type LayoutKey = "2x2" | "2x3" | "3x3" | "strip" | "6inch_4p";

export interface StyleInfo {
  key: StyleKey;
  name: string;
  prompt_prefix: string;
  negative_prompt: string;
  lora_scale: number;
  faceid_scale: number;
}
export interface FilterInfo {
  key: FilterKey;
  name: string;
  /** 与后端 OpenCV 算子近似的 CSS filter 串,取景框实时预览用 */
  css: string;
  /** 暗角强度 0..1,由 MaskOverlay 叠径向渐变还原 */
  vignette: number;
}
export interface FrameInfo {
  key: FrameKey;
  name: string;
  /** 相框边距,相对照片短边的像素数 */
  pad: number;
  /** 底部额外留白(宝丽来白边),0 表示无 */
  bottom_pad: number;
  /** 背景色,或 "checker" 表示棋盘格 */
  bg: string;
  /** 底部标题文字 */
  title: string;
}
export interface LayoutInfo { key: LayoutKey; name: string; cols: number; rows: number }

export interface Meta {
  styles: StyleInfo[];
  filters: FilterInfo[];
  frames: FrameInfo[];
  layouts: LayoutInfo[];
}

export interface JobStatus {
  job_id: string;
  status: "pending" | "running" | "done" | "error";
  current: number;
  total: number;
  msg: string;
  images: string[];
  layout_url?: string | null;
  vram_peak_gb: number;
}
