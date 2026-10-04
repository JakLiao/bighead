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
  const [n, setN] = useState<number>(from);
  const [active, setActive] = useState(false);
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
    setN(count);
    setActive(true);
    const tickOnce = () => {
      count--;
      if (count <= 0) {
        setActive(false);
        onCompleteRef.current();
        return;
      }
      setN(count);
      timer = window.setTimeout(tickOnce, stepMs);
    };
    timer = window.setTimeout(tickOnce, stepMs);
    return () => clearTimeout(timer);
  }, [tick, from, stepMs]);

  if (!active || n <= 0) return null;
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
