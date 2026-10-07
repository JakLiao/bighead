import { useEffect, useRef, useState } from "react";

interface Props {
  /**
   * 触发器:每次自增重启一轮倒计时。
   *
   * 之前用 `show: boolean` 控制,但连拍第 2 张及之后父组件再次
   * setShow(true) 时值没有变化,React 会 bail out(不重渲染),
   * useEffect([show]) 因此不重跑,倒计时冻结在 1 永不触发
   * onComplete —— 表现为"已拍 1/4"卡在"拍摄中..."。
   * 用递增整数当依赖可避免同值 bail out。
   */
  tick: number;
  onComplete: () => void;
  /** 数字之间的间隔(ms) */
  stepMs?: number;
  /** 起始数字 */
  from?: number;
}

export function CountdownOverlay({ tick, onComplete, stepMs = 900, from = 3 }: Props) {
  // 本组件的本地态完全由「父组件给的 key={tick}」决定, 不在 effect 里同步重置。
  //
  // 原来在 effect 开头 setN(from) / setActive(true): 那是「用 effect 派生状态」,
  // 会多一帧旧值, 也触发 react-hooks/set-state-in-effect。改成由父组件传
  // key={tick} 后, tick 一变 React 直接重挂载, useState(from) 天然就是新起点,
  // 语义相同但没有中间帧 —— 倒计时数字不会再闪一下上一轮的残留值。
  const [n, setN] = useState<number>(from);
  // onComplete 走 ref 而不是进依赖数组: 它每次渲染都是新函数(父组件里是内联
  // 箭头函数), 若直接进依赖, 倒计时 effect 会被父组件的任意重渲染打断重启。
  // 这里只在挂载时读一次最新引用 —— 语义上等价于"调用时拿当前回调",
  // 但不再依赖「父组件每次都必然改 tick」这个隐式不变量。
  // LiveCamera 的 snapRef 是同一手法。
  // ref 的同步放在 effect 里, 不在渲染期写(并发模式下不安全)。
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  });

  useEffect(() => {
    if (tick <= 0) return;
    let count = from;
    let timer = 0;
    const tickOnce = () => {
      count--;
      setN(count);
      if (count <= 0) {
        onCompleteRef.current();
        return;
      }
      timer = window.setTimeout(tickOnce, stepMs);
    };
    timer = window.setTimeout(tickOnce, stepMs);
    return () => clearTimeout(timer);
  }, [tick, from, stepMs]);

  if (tick <= 0 || n <= 0) return null;
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div
        key={n}
        className="font-pixel text-[160px] text-white drop-shadow-[0_0_20px_rgba(255,107,107,0.8)] countdown-num"
      >
        {n}
      </div>
    </div>
  );
}
