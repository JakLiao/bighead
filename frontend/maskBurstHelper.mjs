/**
 * 连拍推进助手 —— 处理 P1 引入的 RetakeBar 暂停。
 *
 * P1 起, 前 3 张拍完后会暂停等用户在 RetakeBar 上点「继续」或「重拍本张」。
 * 于是所有「按空格然后等 frames.length >= 4」的脚本都会**永远停在 1/4**,
 * 直到 60s 超时。P1 只适配了 verify-burst.mjs, 三个 mask 脚本被漏掉 ——
 * 它们在 run-all-verify 里显示 (no summary), 很容易被当成"环境问题"放过,
 * 实际上是 TimeoutError 失败。
 *
 * 这里抽成共享模块而不是让三个脚本各抄一遍: 抄一遍的东西下次 P3 改交互时
 * 只会漏抄其中两处, 而漏抄的那两处同样是"静默失败"。
 */

/**
 * 推进到指定张数, 期间自动点掉 RetakeBar 的「继续」。
 *
 * @param {import("playwright").Page} page
 * @param {number} target 目标张数
 * @param {number} timeoutMs 总超时
 * @returns {Promise<number>} 实际推进到的张数
 */
export async function burstTo(page, target = 4, timeoutMs = 60000) {
  const t0 = Date.now();
  // 先点一次: 若上一轮已经停在暂停态, 避免第一轮空等。
  await clickContinue(page);
  while (Date.now() - t0 < timeoutMs) {
    const n = await page
      .evaluate(() => window.__store?.getState().frames.length ?? 0)
      .catch(() => 0);
    if (n >= target) return n;
    await clickContinue(page);
    await page.waitForTimeout(300);
  }
  const n = await page.evaluate(() => window.__store?.getState().frames.length ?? 0);
  if (n < target) {
    throw new Error(
      `连拍未在 ${timeoutMs / 1000}s 内到达 ${target} 张, 实际 ${n} 张。` +
        `若 RetakeBar 未被点掉, 检查 HomePage 的暂停逻辑是否变了。`,
    );
  }
  return n;
}

async function clickContinue(page) {
  const btn = page.locator("button", { hasText: /^继续$/ }).first();
  if ((await btn.count()) === 0) return false;
  if (!(await btn.isVisible().catch(() => false))) return false;
  await btn.click();
  await page.waitForTimeout(350);
  return true;
}
