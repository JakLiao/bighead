/**
 * prefers-reduced-motion 降级验证(清 P1 遗留第 4 条)。
 *
 * 为什么用 computed style 而不是"看截图": 截图只能证明"看起来没动",
 * 证明不了 animation 属性真的被置为 none。而且这里要防的回归是
 * 「新加一个动画类时忘了加进降级名单」—— 那种回归在截图里几乎看不出来,
 * 但会让本脚本红。
 */
import { chromium } from "playwright";

const PASS = [];
const FAIL = [];
const check = (n, c, d = "") => {
  (c ? PASS : FAIL).push(n);
  console.log(`  [${c ? "PASS" : "FAIL"}] ${n}${d ? "  " + d : ""}`);
};

const BASE = (process.env.APP_URL || "http://localhost:5173").replace(/\/$/, "");

// 需要覆盖的动画类。新增动画类时**必须**同步加进 index.css 的
// @media 块, 以及这里 —— 这条注释就是让下一个人看见的地方。
const ANIMATED = [
  { sel: ".shutter-flash", where: "body" },
  { sel: ".countdown-num", where: "body" },
  { sel: ".animate-pose-in", where: "home" },
];

async function readAnimations(page, sel) {
  // page.evaluate(fn, arg) —— arg 必须作为**第二个参数**传给 evaluate,
  // 写在 fn 的参数位再靠闭包是拿不到的(那个位置只存在于浏览器侧)。
  return page.evaluate(
    (s) =>
      Array.from(document.querySelectorAll(s)).map(
        (el) => getComputedStyle(el).animationName,
      ),
    sel,
  );
}

for (const reduce of [false, true]) {
  const browser = await chromium.launch({
    channel: "chrome",
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const ctx = await browser.newContext({
    permissions: ["camera"],
    viewport: { width: 1280, height: 1200 },
    // Playwright 用 emulateMedia 表达这个偏好; 部分版本也认 contextOption,
    // 这里显式在 page 上设置, 行为最确定。
    reducedMotion: reduce ? "reduce" : "no-preference",
  });
  const page = await ctx.newPage();

  // 造一个带全部动画类的宿主页面。
  // 不走真实业务流程: 这里要验的是 CSS 层, 跟业务流程耦合只会让失败难定位。
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.id = "anim-probe";
    d.innerHTML = `
      <div class="shutter-flash" id="a1"></div>
      <div class="countdown-num" id="a2">3</div>
      <div class="animate-pose-in" id="a3">pose</div>
    `;
    d.style.position = "fixed";
    d.style.top = "0";
    d.style.left = "0";
    document.body.appendChild(d);
  });

  const label = reduce ? "reduce" : "no-preference";
  for (const a of ANIMATED) {
    const names = await readAnimations(page, a.sel);
    const allNone = names.length > 0 && names.every((n) => n === "none");
    if (reduce) {
      check(`[${label}] ${a.sel} 动画被关闭`, allNone, names.join(","));
    } else {
      check(
        `[${label}] ${a.sel} 动画正常播放`,
        names.length > 0 && names.every((n) => n !== "none"),
        names.join(","),
      );
    }
  }

  // 关键不变量: 降级后元素仍**可见**。
  // 若用 display:none 降级, 倒计时与 pose 提示会彻底消失 —— 那比动画更糟。
  if (reduce) {
    const vis = await page.evaluate(() => {
      const out = {};
      for (const id of ["a1", "a2", "a3"]) {
        const el = document.getElementById(id);
        if (!el) { out[id] = "missing"; continue; }
        const cs = getComputedStyle(el);
        out[id] =
          cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0"
            ? "hidden"
            : "visible";
      }
      return out;
    });
    check(
      `[${label}] 降级后元素仍可见(未被 display:none 隐藏)`,
      Object.values(vis).every((v) => v === "visible"),
      JSON.stringify(vis),
    );
  }

  await browser.close();
}

console.log(`\nResult: ${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) console.log("FAILED:", FAIL.join(" | "));
process.exit(FAIL.length ? 1 : 0);
