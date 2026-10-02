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
export interface FilterInfo { key: FilterKey; name: string }
export interface FrameInfo { key: FrameKey; name: string }
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
