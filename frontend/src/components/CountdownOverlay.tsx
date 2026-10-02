import { useEffect, useState } from "react";

interface Props {
  show: boolean;
  onComplete: () => void;
}

export function CountdownOverlay({ show, onComplete }: Props) {
  const [n, setN] = useState<number>(3);

  useEffect(() => {
    if (!show) return;
    setN(3);
    let count = 3;
    let timer = 0;
    const tick = () => {
      count--;
      if (count <= 0) {
        onComplete();
        return;
      }
      setN(count);
      timer = window.setTimeout(tick, 900);
    };
    timer = window.setTimeout(tick, 900);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  if (!show) return null;
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
