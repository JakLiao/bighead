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
/**
 * 年代处理。与 FilterKey 正交 —— 同一个滤镜可配任一年代, 反之亦然,
 * 所以它是顶层独立维度, 不挂在 FilterInfo 下。
 */
export type EraKey = "modern" | "vintage_2000";

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
export interface EraInfo { key: EraKey; name: string }

export interface Meta {
  styles: StyleInfo[];
  filters: FilterInfo[];
  frames: FrameInfo[];
  layouts: LayoutInfo[];
  era_presets: EraInfo[];
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

/** 单条贴纸册元数据。缺省字段见后端 _normalize_entry。 */
export interface AlbumEntry {
  title: string;
  note: string;
  /** 标签列表, 后端会裁剪到 16 字节/个、8 个上限 */
  tags: string[];
  favorite: boolean;
  updated_at: number;
}

/** /api/gallery items 元素的完整形态(磁盘信息 + 元数据)。 */
export interface GalleryItem {
  job_id: string;
  mtime: number;
  thumbs: string[];
  title: string;
  note: string;
  tags: string[];
  favorite: boolean;
  updated_at: number;
}

export interface GalleryResponse {
  items: GalleryItem[];
}
