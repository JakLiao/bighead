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

/**
 * 一条产物。kind 决定它能不能被"重新编辑"。
 *
 * 只有 photo 可编辑: 拼图是 collage 的成品(已裁切/加框/带拼图间隙),
 * 分享卡是 4:3 品牌卡(带 footer), 在这两者上再贴贴纸等于二次创作一张
 * 尺寸/构图都不对的东西。宁可不给入口, 也不要给一个结果必然失真的入口。
 */
export type GalleryMediaKind = "photo" | "layout" | "share";

export interface GalleryMedia {
  kind: GalleryMediaKind;
  url: string;
  /** 界面标签, 如「原图 2」「拼图」。 */
  label: string;
}

/** /api/gallery items 元素的完整形态(磁盘信息 + 元数据)。 */
export interface GalleryItem {
  job_id: string;
  mtime: number;
  /** 卡片缩略图(至多 4 张, 优先 share)。语义见 backend 的 _pick_thumb。 */
  thumbs: string[];
  /** 全量产物(所有原图 + 拼图 + 分享卡), 供大图查看灯箱逐页翻。 */
  media: GalleryMedia[];
  title: string;
  note: string;
  tags: string[];
  favorite: boolean;
  updated_at: number;
}

/** 标签 + 出现次数, 供贴纸册筛选条渲染。 */
export interface TagCount {
  tag: string;
  count: number;
}

export interface GalleryResponse {
  items: GalleryItem[];
  tags: TagCount[];
  /**
   * 筛选后的**总条数**(与 items 长度无关)。
   *
   * tags 的 count 也基于这个全集, 所以分页时它不随滚动变化。
   * 前端用它显示「已显示 N / 共 M 条」。
   */
  total: number;
  /** 第 offset 页之后是否还有更多。false 时前端应停掉无限滚动的观察器。 */
  has_more: boolean;
}

/** 批量删除的逐项结果。后端不做整体回滚, 三类都要能被前端如实展示。 */
export interface BatchDeleteResult {
  /** 真的删掉了(软删除时是"已移进回收站", permanent 时是"目录已 rmtree") */
  deleted: string[];
  /** 请求时就已经不存在 —— 通常是另一个标签页先删了, 不算错误 */
  missing: string[];
  /** 非法 id / 越界 / 移动失败(文件被占用等), 带原因 */
  failed: { job_id: string; error: string }[];
  deleted_count: number;
  /** true = 不可恢复的真删; false = 已进回收站, N 天后可恢复 */
  permanent: boolean;
  purge_after_days: number;
}

/** 单条删除的结果。 */
export interface AlbumDeleteResult {
  job_id: string;
  deleted: boolean;
  permanent: boolean;
  /** 回收站里的目录名 "<毫秒时间戳>_<job_id>", 软删除时才有 */
  trash_name?: string;
  purge_after_days?: number;
}

/**
 * 回收站保留天数(天)。**必须与后端 `gallery.TRASH_RETENTION_DAYS` 一致。**
 *
 * 只有两处需要它 —— 删除前的瞬时提示(不发请求, 见 AlbumEditor 里
 * RETENTION_HINT 的说明)。回收站列表里的天数是接口现给的, 不依赖此常量。
 * 改后端保留期时记得同步这里, 否则只差一个显示数字。
 */
export const RETENTION_DAYS = 7;

/** 回收站列表里的一条。 */
export interface TrashItem {
  job_id: string;
  /** 内部目录名。前端不需要用它 —— 恢复/删除都只传 job_id。 */
  trash_name: string;
  /** Unix 秒 */
  deleted_at: number;
  /** 目录内所有文件的总字节数 */
  size: number;
  /** 指向 /outputs/_trash/... 的缩略图 URL */
  thumbs: string[];
}

export interface TrashResponse {
  items: TrashItem[];
  /** 回收站里的总条数(可能 > items.length, 见 truncated) */
  total: number;
  /** 全回收站占用的总字节数 */
  total_size: number;
  retention_days: number;
  /** true 表示条数超过上限, items 只含最近的一批 */
  truncated: boolean;
  /** 本次读取时被保留期规则清掉的 job_id */
  purged: string[];
}

/** PATCH 返回体。changed=false 表示内容无变化, 服务端没写盘。 */
export type AlbumPatchResult = AlbumEntry & { job_id: string; changed: boolean };

/** /api/share/save 的返回。 */
export interface ShareSaveResult {
  job_id: string;
  share_url: string;
}
