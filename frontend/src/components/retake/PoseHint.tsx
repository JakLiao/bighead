/**
 * 拍照前的 pose 文字浮层。
 *
 * 4 个固定词按拍摄顺序循环:嘟嘴 / 比心 / 看镜头 / 笑僵。
 * 与 store 的 showPose(用户偏好)双重控制: 关掉时整个组件不渲染。
 *
 * 关键约束: 不能进入 React 渲染分支去读 poseIndex —— 那样会在每次
 * 拍照后强制重渲染 LiveCamera(父组件)与取景层, 引发「视频流闪烁」。
 * 这里用 props 传 pose 触发 useEffect 重置 key, 让 CSS 动画从头
 * 播放; 文本节点直接显示在当前值上。
 */
interface Props {
  /** 当前应当显示的 pose 词, 由父组件按 frames.length 推算 */
  pose: string;
  /** 是否显示(整体开关) */
  visible: boolean;
}

export function PoseHint({ pose, visible }: Props) {
  if (!visible) return null;
  return (
    <div
      key={pose}
      className="absolute top-4 left-1/2 -translate-x-1/2 z-30
                 bg-brick/90 text-white px-4 py-1.5 rounded-full
                 font-pixel text-sm shadow-lg
                 animate-pose-in pointer-events-none select-none"
    >
      {pose}
    </div>
  );
}
