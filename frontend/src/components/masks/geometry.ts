/**
 * 蒙版镂空形状生成器。
 *
 * 所有形状都在「单位坐标系」(0..1 的正方形)里描述,由 renderMask 统一缩放到
 * 实际画布。这样同一个预设能同时服务 640px 的取景预览和 1280px 的成片,
 * 且形状比例完全一致 —— 这正是"所见即所得"的前提。
 *
 * 设计约束:全部是**确定性**的,不含 Math.random。
 * 装饰位置一律在 maskDefs 里硬编码,而非随机撒点 —— 否则预览和成片的
 * 贴纸位置会不一样,用户会立刻发现"拍下来星星换位置了"。
 */

/** 极坐标谐波形状:一条万能公式生成花瓣/流体/齿轮/云朵等。 */
function radialShape(
  cx: number,
  cy: number,
  r: number,
  harmonics: { n: number; amp: number; phase?: number }[],
  steps = 256,
): string {
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    let rr = r;
    for (const h of harmonics) {
      rr += r * h.amp * Math.cos(h.n * t + (h.phase ?? 0));
    }
    pts.push(
      `${(cx + rr * Math.cos(t)).toFixed(4)},${(cy + rr * Math.sin(t)).toFixed(4)}`,
    );
  }
  return `M${pts[0]}L${pts.slice(1).join("L")}Z`;
}

/** N 角星。rInner/rOuter 决定尖锐程度,rotOffset 为首角相位(弧度)。 */
function starShape(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  points: number,
  rotOffset = -Math.PI / 2,
): string {
  const pts: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = (i / (points * 2)) * Math.PI * 2 + rotOffset;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(4)},${(cy + r * Math.sin(a)).toFixed(4)}`);
  }
  return `M${pts[0]}L${pts.slice(1).join("L")}Z`;
}

/** 经典心形三次贝塞尔,定义在 0..1 盒子里(顶部为 0,尖端为 1)。 */
const HEART_UNIT =
  "M0.5,0.96C0.16,0.66 0.0,0.46 0.0,0.29C0.0,0.13 0.12,0.0 0.26,0.0" +
  "C0.37,0.0 0.46,0.07 0.5,0.16C0.54,0.07 0.63,0.0 0.74,0.0" +
  "C0.88,0.0 1.0,0.13 1.0,0.29C1.0,0.46 0.84,0.66 0.5,0.96Z";

/** 圆形(用贝塞尔近似,兼容没有 arcTo 的场景)。 */
const CIRCLE_UNIT =
  "M0.5,0C0.2239,0 0,0.2239 0,0.5C0,0.7761 0.2239,1 0.5,1" +
  "C0.7761,1 1,0.7761 1,0.5C1,0.2239 0.7761,0 0.5,0Z";

/** 圆角矩形(r 为圆角半径,0..0.5)。 */
function roundRectUnit(r: number): string {
  const c = Math.min(0.5, r);
  return (
    `M${c},0L${1 - c},0Q1,0 1,${c}L1,${1 - c}Q1,1 ${1 - c},1` +
    `L${c},1Q0,1 0,${1 - c}L0,${c}Q0,0 ${c},0Z`
  );
}

/**
 * 猫耳头:一个圆 + 两只尖耳朵。
 * 拆成 3 条独立闭合路径 —— 若合并成一条多子路径,destination-out 的填充规则
 * 会让重叠处出现"洞中洞"(画出来像熊猫),拆开各自填充才能得到干净的并集。
 */
const CAT_HEAD =
  "M0.5,0.16A0.34,0.34 0 1,1 0.5,0.84A0.34,0.34 0 1,1 0.5,0.16Z";
const CAT_EAR_L = "M0.30,0.10L0.40,0.40L0.08,0.26Z";
const CAT_EAR_R = "M0.70,0.10L0.60,0.40L0.92,0.26Z";

/** 熊耳圆头:圆头 + 两只圆耳,同样拆成 3 条。 */
const BEAR_HEAD =
  "M0.5,0.18A0.34,0.34 0 1,1 0.5,0.86A0.34,0.34 0 1,1 0.5,0.18Z";
const BEAR_EAR_L =
  "M0.24,0.22A0.13,0.13 0 1,1 0.24,0.48A0.13,0.13 0 1,1 0.24,0.22Z";
const BEAR_EAR_R =
  "M0.76,0.22A0.13,0.13 0 1,1 0.76,0.48A0.13,0.13 0 1,1 0.76,0.22Z";

/** 云朵:三个凸起 + 平底,用谐波+下半部压平的方式不好做,直接给闭合路径。 */
const CLOUD_UNIT =
  "M0.13,0.62A0.15,0.15 0 0,1 0.16,0.32A0.19,0.19 0 0,1 0.50,0.24" +
  "A0.17,0.17 0 0,1 0.80,0.36A0.14,0.14 0 0,1 0.84,0.62Z";

/**
 * 单人形状库。每个函数返回**一组独立闭合路径**(数组),
 * 渲染时逐条 destination-out 填充 —— 重叠部分被擦两次也依然是"擦掉",
 * 所以并集形状(猫耳、熊耳)可以任意重叠而不出现"洞中洞"。
 */
export const SINGLE_SHAPES: Record<string, () => string[]> = {
  heart: () => [HEART_UNIT],
  star: () => [starShape(0.5, 0.5, 0.5, 0.21, 5)],
  star6: () => [starShape(0.5, 0.5, 0.5, 0.26, 6)],
  burst: () => [starShape(0.5, 0.5, 0.5, 0.34, 12)],
  circle: () => [CIRCLE_UNIT],
  flower: () => [radialShape(0.5, 0.5, 0.34, [{ n: 6, amp: 0.22 }])],
  cloud: () => [CLOUD_UNIT],
  cat: () => [CAT_HEAD, CAT_EAR_L, CAT_EAR_R],
  bear: () => [BEAR_HEAD, BEAR_EAR_L, BEAR_EAR_R],
  blob: () => [
    radialShape(0.5, 0.5, 0.36, [
      { n: 3, amp: 0.16, phase: 0.4 },
      { n: 5, amp: 0.07, phase: 1.2 },
    ]),
  ],
  squircle: () => [radialShape(0.5, 0.5, 0.42, [{ n: 4, amp: 0.1, phase: Math.PI / 4 }])],
  ticket: () => [roundRectUnit(0.12)],
};

export type SingleShapeKey = keyof typeof SINGLE_SHAPES;

/**
 * 双人形状:每人一条独立路径。
 *
 * 双人必须用「wide」空间(以画面宽度为基准)而不是正方形空间 ——
 * 正方形空间下两个圆直径上限只有短边的一半,两个洞会紧贴甚至重叠,
 * 粘连成一个花生形。用满宽度后每侧能占到约 0.23w,中间留出清晰间隙。
 */
export const DUAL_SHAPES: Record<string, () => string[]> = {
  dual_circle: () => [
    shiftUnit(CIRCLE_UNIT, -0.25, -0.03, 0.46),
    shiftUnit(CIRCLE_UNIT, 0.25, -0.03, 0.46),
  ],
  dual_heart: () => [
    shiftUnit(HEART_UNIT, -0.25, -0.05, 0.44),
    shiftUnit(HEART_UNIT, 0.25, -0.05, 0.44),
  ],
  dual_star: () => [
    shiftUnit(starShape(0.5, 0.5, 0.5, 0.22, 5), -0.25, -0.05, 0.46),
    shiftUnit(starShape(0.5, 0.5, 0.5, 0.22, 5), 0.25, -0.05, 0.46),
  ],
  dual_bubble: () => [
    shiftUnit(radialShape(0.5, 0.5, 0.34, [{ n: 3, amp: 0.1, phase: 0.5 }]), -0.25, -0.04, 0.46),
    shiftUnit(radialShape(0.5, 0.5, 0.34, [{ n: 3, amp: 0.1, phase: 2.1 }]), 0.25, -0.04, 0.46),
  ],
  dual_blob: () => [
    shiftUnit(
      radialShape(0.5, 0.5, 0.36, [{ n: 3, amp: 0.16, phase: 0.4 }, { n: 5, amp: 0.07, phase: 1.2 }]),
      -0.25, -0.04, 0.46,
    ),
    shiftUnit(
      radialShape(0.5, 0.5, 0.36, [{ n: 3, amp: 0.16, phase: 2.0 }, { n: 5, amp: 0.07, phase: 0.3 }]),
      0.25, -0.04, 0.46,
    ),
  ],
  dual_rounded: () => [
    shiftUnit(roundRectUnit(0.14), -0.25, -0.04, 0.44),
    shiftUnit(roundRectUnit(0.14), 0.25, -0.04, 0.44),
  ],
};

/**
 * 把单位路径按 (scale) 缩放并平移到 (dx,dy),返回仍是 0..1 盒子的路径。
 * 通过 ctx 变换实现,故这里只做字符串级的平移缩放(对 M/L/Q/C 指令通用)。
 */
function shiftUnit(path: string, dx: number, dy: number, scale: number): string {
  const k = scale / 2;
  return path.replace(/([MLQC])\s*([^MLQCZ]+)/g, (_m, cmd: string, nums: string) => {
    const vals = nums.trim().split(/[\s,]+/).map(Number);
    const out: string[] = [];
    for (let i = 0; i < vals.length; i += 2) {
      out.push((vals[i] * scale + dx + 0.5 - k).toFixed(4));
      out.push((vals[i + 1] * scale + dy + 0.5 - k).toFixed(4));
    }
    return `${cmd}${out.join(",")}`;
  });
}

/** 供贴纸装饰复用的形状(单位坐标,已居中)。 */
export const STICKER_SHAPES: Record<string, string> = {
  heart: HEART_UNIT,
  star: starShape(0.5, 0.5, 0.48, 0.2, 5),
  sparkle: starShape(0.5, 0.5, 0.5, 0.12, 4),
  flower: radialShape(0.5, 0.5, 0.32, [{ n: 5, amp: 0.24 }]),
  circle: CIRCLE_UNIT,
  cloud: CLOUD_UNIT,
  cat: CAT_HEAD,
  bear: BEAR_HEAD,
  blob: radialShape(0.5, 0.5, 0.36, [{ n: 3, amp: 0.18, phase: 0.9 }]),
};

export type StickerShapeKey = keyof typeof STICKER_SHAPES;
