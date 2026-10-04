/**
 * 蒙版图库抽屉。
 *
 * 布局参考给定的图库样式图:顶部标题栏 + 搜索 + 分类 chips,
 * 主体是多列缩略图网格,每张卡片下方带名称与标签。
 * 覆盖在拍照页之上而不新开路由,是为了不打断"选蒙版 → 回到取景框 → 拍照"的动线:
 * 点一下就应用并自动收起,取景框里立刻看到效果。
 *
 * 内置蒙版与位图蒙版混排展示(内置的归在"内置"分类),
 * 因为对用户来说它们都是"可选的蒙版",不该分两个入口。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  filterMasks,
  getAllSummaries,
  getCategories,
  getMask,
  loadMaskManifest,
  manifestError,
} from "./masks/maskLibrary";
import { renderMaskLayer } from "./masks/renderMask";
import type { MaskSummary } from "./masks/maskDefs";

interface Props {
  selected: string;
  onSelect: (key: string) => void;
  onClose: () => void;
}

const ALL = "全部";

/**
 * 卡片缩略图。
 *
 * 内置蒙版用真实渲染器画 canvas(先铺灰底代表照片,镂空处透出灰),
 * 位图蒙版直接用 <img> —— 素材本身就是带透明通道的成品,
 * 交给浏览器解码比搬进 canvas 再 toDataURL 更快、也更省内存。
 */
function MaskCard({
  item,
  active,
  onSelect,
}: {
  item: MaskSummary;
  active: boolean;
  onSelect: (key: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const def = getMask(item.key);
  const src = def && def.kind === "image" ? def.src : null;

  // 内置蒙版:用渲染器把缩略图画出来。
  // 必须按卡片的 4:3 比例渲染 —— 若先渲染成正方形再拉伸,
  // 蒙版会被压扁,和取景框里看到的形状对不上。
  //
  // 依赖只放 item.key:def 由它推导。放 def 进依赖会出问题 ——
  // getMask() 每次调用都返回新对象,会导致 effect 每渲染一次就重跑一次。
  useEffect(() => {
    if (item.kind !== "proc") return;
    const c = canvasRef.current;
    if (!c) return;
    const W = 176;
    const H = Math.round((W * 3) / 4);
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    // 渐变灰底代表照片,一眼能看出洞在哪
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#5b6b8c");
    grad.addColorStop(1, "#8c5b6b");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    const layer = renderMaskLayer(getMask(item.key), W, H);
    if (layer) ctx.drawImage(layer, 0, 0);
  }, [item.key, item.kind]);

  return (
    <button
      data-mask={item.key}
      data-mask-gallery-card={item.key}
      onClick={() => onSelect(item.key)}
      title={item.hint ?? item.name}
      className={`group flex flex-col overflow-hidden rounded-xl border-2 text-left transition ${
        active
          ? "border-brick bg-brick/10 shadow-lg"
          : "border-pink bg-white/80 hover:border-brick/60 hover:bg-pink/20"
      }`}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-deepblue/80">
        {item.kind === "image" && src ? (
          <img
            src={src}
            alt={item.name}
            loading="lazy"
            className="h-full w-full object-cover"
            // 素材加载失败时回退到灰底,而不是留一个破图
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
            }}
          />
        ) : (
          <canvas ref={canvasRef} className="h-full w-full object-cover" />
        )}
        {active && (
          <span className="absolute right-1 top-1 rounded-full bg-brick px-1.5 py-0.5 text-[9px] text-white">
            使用中
          </span>
        )}
      </div>
      <div className="px-1.5 py-1">
        <div className="truncate text-[11px] leading-tight text-brown">{item.name}</div>
        <div className="mt-0.5 flex flex-wrap gap-0.5">
          <span className="rounded bg-pink/70 px-1 text-[9px] leading-tight text-brown/80">
            {item.category}
          </span>
          {item.audience === "dual" && (
            <span className="rounded bg-lilac/70 px-1 text-[9px] leading-tight text-brown/80">
              双人
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

export function MaskGallery({ selected, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(ALL);
  const [ready, setReady] = useState(false);

  // 打开时确保 manifest 已就位。内置蒙版不依赖它,
  // 所以即便素材缺失,图库也仍然能用(只是少了位图那部分)。
  useEffect(() => {
    let alive = true;
    loadMaskManifest().then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // ready 只作为「manifest 已就位」的信号, 体内不读它 —— eslint 会报
  // unnecessary dependency。显式 void 一下表达意图: ready 翻转时重算。
  const all = useMemo(() => {
    void ready;
    return getAllSummaries();
  }, [ready]);
  const categories = useMemo(() => [ALL, ...getCategories(all)], [all]);
  const list = useMemo(() => filterMasks(all, query, category), [all, query, category]);
  const selectedDef = getMask(selected);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-cream/95 backdrop-blur-sm">
      {/* 顶部:标题 + 关闭 */}
      <div className="flex items-center justify-between border-b border-pink bg-white/80 px-4 py-3">
        <div>
          <div className="font-pixel text-sm text-brick">蒙版图库</div>
          <div className="text-[11px] text-brown/60">
            共 {all.length} 款 · 点选即应用到取景框
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-full border-2 border-brick px-4 py-1.5 text-xs text-brick hover:bg-pink/40"
        >
          关闭 (Esc)
        </button>
      </div>

      {/* 搜索 + 分类 */}
      <div className="border-b border-pink/60 bg-white/60 px-4 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索蒙版名称或标签，如「珍珠」「卡通」"
          className="w-full rounded-full border border-pink bg-white px-4 py-1.5 text-xs text-brown outline-none placeholder:text-brown/40 focus:border-brick"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`rounded-full border px-3 py-1 text-[11px] transition ${
                category === c
                  ? "border-brick bg-brick text-white"
                  : "border-pink bg-white text-brown hover:bg-pink/40"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* 网格 */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {list.length === 0 ? (
          <div className="py-16 text-center text-xs text-brown/60">
            {!ready
              ? "正在加载图库…"
              : manifestError()
                ? `素材清单加载失败（${manifestError()}），仅显示内置蒙版`
                : "没有匹配的蒙版，换个关键词或分类试试"}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {list.map((m) => (
              <MaskCard
                key={m.key}
                item={m}
                active={selected === m.key}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>

      {/* 底部:当前选中 */}
      <div className="border-t border-pink bg-white/80 px-4 py-2 text-[11px] text-brown/70">
        当前:
        <span className="font-medium text-brick">
          {selected === "none" ? "不使用蒙版" : (selectedDef?.name ?? selected)}
        </span>
        {selectedDef?.hint ? ` · ${selectedDef.hint}` : ""}
      </div>
    </div>
  );
}
