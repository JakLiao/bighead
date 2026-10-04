import { useEffect, useRef } from "react";
import { MASKS, MASKS_BY_KEY, type MaskDef } from "./masks/maskDefs";
import { getMask } from "./masks/maskLibrary";
import { renderMaskThumb } from "./masks/renderMask";

interface Props {
  selected: string;
  onSelect: (key: string) => void;
  /** 图库里的蒙版数量(不含内置),用于入口按钮上的角标 */
  galleryCount: number;
  onOpenGallery: () => void;
}

type Tab = "none" | "single" | "dual";

const TABS: { key: Tab; label: string }[] = [
  { key: "none", label: "无" },
  { key: "single", label: "单人" },
  { key: "dual", label: "双人" },
];

/** 该 key 是否来自图库(而非内置 15 个)。 */
function isGalleryKey(key: string): boolean {
  if (!key || key === "none") return false;
  return !MASKS_BY_KEY[key] && !!getMask(key);
}

/** 由当前选中的蒙版反推该激活哪个标签页。图库蒙版也要能正确落到单人/双人页。 */
function tabOf(maskKey: string): Tab {
  if (!maskKey || maskKey === "none") return "none";
  return getMask(maskKey)?.audience === "dual" ? "dual" : "single";
}

/** 该标签页默认选中的蒙版:切页即选中,保证预览与标签一致。 */
function firstOf(tab: Tab): string {
  if (tab === "none") return "none";
  return MASKS.find((m) => m.audience === tab)?.key ?? "none";
}

/**
 * 缩略图直接用真实渲染器绘制,所以"选择条里看到的就是拍出来的"。
 * 缩略图里先铺一层灰底代表照片,镂空处透出灰 —— 一眼能看出洞在哪。
 */
function MaskThumb({ mask, active }: { mask: MaskDef; active: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const S = 44;
    c.width = S;
    c.height = S;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#4a4a55";
    ctx.fillRect(0, 0, S, S);
    const layer = renderMaskThumb(mask, S);
    if (layer) ctx.drawImage(layer, 0, 0);
  }, [mask]);

  return (
    <canvas
      ref={ref}
      className="h-11 w-11 rounded-md"
      style={{ outline: active ? "2px solid #FF6B6B" : "1px solid rgba(0,0,0,0.12)" }}
    />
  );
}

function MaskButton({
  mask,
  active,
  onSelect,
}: {
  mask: MaskDef;
  active: boolean;
  onSelect: (k: string) => void;
}) {
  return (
    <button
      data-mask={mask.key}
      onClick={() => onSelect(mask.key)}
      title={mask.hint ?? mask.name}
      className={`flex flex-col items-center gap-1 px-2 py-1.5 rounded-xl border transition ${
        active
          ? "bg-brick/15 border-brick shadow"
          : "bg-white/70 border-pink hover:bg-pink/30"
      }`}
    >
      <MaskThumb mask={mask} active={active} />
      <span className="text-[10px] leading-none">{mask.name}</span>
    </button>
  );
}

function PlainOption({ active, onSelect }: { active: boolean; onSelect: (k: string) => void }) {
  return (
    <button
      data-mask="none"
      onClick={() => onSelect("none")}
      className={`col-span-5 flex flex-col items-center gap-1 px-2 py-3 rounded-xl border transition ${
        active
          ? "bg-brick/15 border-brick shadow"
          : "bg-white/70 border-pink hover:bg-pink/30"
      }`}
    >
      <span className="h-11 w-11 rounded-md border border-dashed border-brick/50 grid place-items-center text-[10px] text-brick">
        无
      </span>
      <span className="text-[10px] leading-none">不使用蒙版 · 原图直出</span>
    </button>
  );
}

export function MaskStrip({
  selected,
  onSelect,
  galleryCount,
  onOpenGallery,
}: Props) {
  // 标签页不另存状态,始终由 selected 推导。这样 store 里的 maskKey
  // 是唯一真相源,不会出现"标签显示双人、预览却是单人爱心"的错位。
  const activeTab = tabOf(selected);

  return (
    <div data-mask-strip>
      <div className="mb-2 flex items-center gap-2">
        <div role="tablist" className="flex flex-1 gap-1">
          {TABS.map((t) => {
            const count =
              t.key === "none" ? 0 : MASKS.filter((m) => m.audience === t.key).length;
            const on = activeTab === t.key;
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={on}
                data-tab={t.key}
                onClick={() => onSelect(firstOf(t.key))}
                className={`flex-1 px-3 py-1.5 rounded-full text-xs border transition ${
                  on
                    ? "bg-brick text-white border-brick shadow"
                    : "bg-white/70 text-brown border-pink hover:bg-pink/40"
                }`}
              >
                {t.label}
                {count > 0 && (
                  <span className={`ml-1 text-[10px] ${on ? "text-white/70" : "text-brown/50"}`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* 图库入口:内置 15 个只是"基础款",图库里还有素材蒙版 */}
        <button
          data-open-mask-gallery
          onClick={onOpenGallery}
          className="flex items-center gap-1 rounded-full border-2 border-dashed border-brick/70 px-3 py-1.5 text-xs text-brick transition hover:bg-pink/30"
        >
          <span aria-hidden>▦</span> 图库
          {galleryCount > 0 && (
            <span className="rounded-full bg-brick px-1.5 text-[10px] text-white">
              {galleryCount}
            </span>
          )}
        </button>
      </div>

      <div role="tabpanel" className="grid grid-cols-5 gap-2 px-1 py-1">
        {activeTab === "none" ? (
          <PlainOption active={selected === "none"} onSelect={onSelect} />
        ) : (
          MASKS.filter((m) => m.audience === activeTab).map((m) => (
            <MaskButton
              key={m.key}
              mask={m}
              active={selected === m.key}
              onSelect={onSelect}
            />
          ))
        )}
      </div>

      {/* 选中了图库蒙版时给出提示,否则用户会疑惑"选了图为什么这里没高亮" */}
      {isGalleryKey(selected) && (
        <div className="mt-2 flex items-center justify-between rounded-lg border border-dashed border-brick/50 bg-white/70 px-3 py-1.5 text-[11px] text-brown">
          <span>
            当前使用图库蒙版
            <span className="ml-1 font-medium text-brick">{getMask(selected)?.name}</span>
          </span>
          <button
            onClick={onOpenGallery}
            className="rounded-full border border-brick px-2 py-0.5 text-brick hover:bg-pink/40"
          >
            打开图库更换
          </button>
        </div>
      )}
    </div>
  );
}
