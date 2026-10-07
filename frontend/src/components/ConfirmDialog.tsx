import { useEffect, useRef } from "react";
import { useEscape } from "./album/useEscape";

/**
 * 危险操作确认弹窗。
 *
 * ## 为什么从"按钮变色"改成弹窗
 *
 * 原来的两段式确认是**就地换按钮**: 点「删除选中的 20 条」之后, 那个按钮
 * 变成「移到回收站 20 条」。这个设计有个致命的感知问题 ——
 * **变化发生在用户视线的焦点之外**。
 *
 * 批量删除的入口在页面顶栏, 而用户的注意力在卡片区(他刚框完选, 眼睛还
 * 在看那20 张卡)。顶栏那枚按钮换个颜色, 很可能完全没进视野, 于是他的
 * 心智停在"我点了删除"→ 页面没反应 → 再点一下卡片 → 选中集变了 →
 * "这个界面有毛病"。截图里就是这个状态: 一排卡片都选中着, 顶栏按钮变了色,
 * 但下一步该做什么没有任何提示。
 *
 * 弹窗把"需要你决策"这件事**搬到注意力所在的地方**:
 *   - 遮罩压暗整页,  peripheral 视觉被物理阻断, 不可能"错过"。
 *   - 数字在弹窗中央, 而不是缩在顶栏。
 *   - 「取消」和「确认」并排, 且**默认焦点落在取消上**。
 *
 * ## Esc / 点击遮罩 / 取消 三条退路
 *
 * 危险操作的确认弹窗**必须**给一条不假思索就能退出的路。任一键即可撤销,
 * 而不是"要用户想一下怎么关"。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  hint,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
  testId = "",
}: {
  open: boolean;
  title: string;
  /** 主体内容。要含数量 —— 确认的动作必须有明确的对象。 */
  message: React.ReactNode;
  /** 补充说明(如保留期)。放 message 之后, 用更弱的视觉权重。 */
  hint?: React.ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** 追加到 data-testid 后面, 便于同一页面上多个弹窗区分。 */
  testId?: string;
}) {
  /**
   * 确认按钮的 ref。
   *
   * **故意不自动聚焦到确认上**。批量删除一次就是几十张, 让"回车"直接等于
   * 删除是危险默认值 —— 用户在弹窗出现前很可能正在按回车(比如刚框完选),
   * 那一键就会立刻删掉20 张。焦点默认落在「取消」, 确认需要主动点或 Tab 过去。
   */
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEscape(onCancel, open && !busy);

  // 弹窗打开时把焦点移进来, 否则焦点还留在被遮住的顶栏按钮上,
  // Tab 会从页面顶部重新走一遍, 且读屏软件读不到弹窗内容。
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  // busy 时禁掉退路: 请求已经发出, 此时"取消"会让人以为能撤销。
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center
                 bg-black/40 p-4"
      // 点遮罩 = 取消。与 TrashPanel 一致。
      onClick={busy ? undefined : onCancel}
      data-confirm-overlay={testId || undefined}
    >
      {/*
        居中。
        弹窗是"一件事"而不是一个表单, 用户的视线会落在中间, 居中文案
        更符合这个语境; 左对齐会让标题和正文都挤在左边, 右边空一大块,
        像是没排完。
      */}
      <div
        className="w-full max-w-sm bg-cream rounded-lg border border-pink p-6
                   text-center"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-confirm-dialog={testId || undefined}
      >
        {/*
          标题刻意**不用 font-pixel**。

          像素字体的基线与正文差一截, 混排时"移到回收站?"的问号会明显
          偏上, 而问号是标题里最容易被盯住的字符 —— 整个弹窗第一眼就看它。
          这里换成常规字体, 并去掉问号: 问号会让人下意识去读"这是问句,
          答案在哪", 而弹窗本身已经把确认/取消摆出来了, 不需要再问一遍。
        */}
        <div className="text-base font-medium text-brick mb-2" data-confirm-title="">
          {title}
        </div>
        <div className="text-sm text-brown">{message}</div>
        {hint && <div className="text-xs text-brown/60 mt-1">{hint}</div>}

        <div className="flex justify-center gap-2 mt-5">
          <button
            type="button"
            ref={cancelRef}
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-2 text-xs rounded-full border border-pink
                       bg-white text-brown disabled:opacity-40"
            data-confirm-cancel={testId || undefined}
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="px-3 py-2 text-xs rounded-full bg-red-500 text-white
                       hover:bg-red-600 disabled:opacity-50"
            data-confirm-ok={testId || undefined}
          >
            {busy ? "处理中..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
