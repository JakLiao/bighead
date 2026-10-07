import { useEffect } from "react";

/**
 * 按 Esc 时回调。
 *
 * 刻意挂 document 而不是抽屉容器: 抽屉是 fixed 全屏遮罩, 焦点在遮罩内的
 * input/textarea 时, 键盘事件同样会冒泡到 document。挂容器上并依赖容器
 * 获得焦点, 会在「正在打字时按 Esc」这个最常见的场景下静默失效。
 *
 * 放在 components/album/ 而不是新建 hooks/ 目录: 本项目目前没有 hooks 层,
 * 而这个 hook 只有 AlbumEditor 一处用。就近组织比为一个函数开一层目录更
 * 符合现有约定; 若将来出现第三个使用方, 再上提到 hooks/ 不迟。
 */
export function useEscape(onEscape: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onEscape, active]);
}
