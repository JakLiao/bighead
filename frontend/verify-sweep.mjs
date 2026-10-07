/**
 * 清扫 outputs/ 里的测试残留。
 *
 * ============================ 为什么需要它 ============================
 *
 * verifyHarness.mjs 的快照 diff 能保证"**今后**的脚本不再泄漏", 但它管不了
 * 已经躺在磁盘上的存量 —— 在它上线之前, 已有几十个无主目录和若干孤儿键。
 *
 * 其中最麻烦的是 **hex 形态的那一批**: 走 /api/capture/save 的脚本拿到的
 * job_id 是后端随机生成的 12 位 hex, 与用户自己的真实 job 在磁盘上**完全同构**。
 * 靠目录名判断不出归属, 所以本脚本对这类数据只走一条路: 读 _album.json 里的
 * title/tags, 看有没有测试留下的标记。
 *
 * ============================ 刻意不做的事 ============================
 *
 * **不碰任何无法判定归属的目录。** 用户自己的 12 位 hex job 与测试造的 hex job
 * 长得一模一样, 靠"创建时间接近某次测试运行"去猜就是在赌用户的数据不重要。
 * 误删不可恢复, 漏删只是难看 —— 这个不对称决定了宁可少清。
 *
 * 所以这里能清掉的只有两类:
 *   1. 目录名匹配**历史上用过的固定前缀**(bt/pt/ui/tr/tk/tp/tb/tu/mq):
 *      这些前缀是当年各脚本自己起的, 新脚本不再产生, 属于纯垃圾。
 *   2. title/tags 带**运行标记**的条目: harness 造的数都会打标记,
 *      清理失败也能被重新捞出来。
 *
 * ============================ 用法 ============================
 *
 *   node verify-sweep.mjs                    # dry-run, 只列不删(默认)
 *   node verify-sweep.mjs --yes              # 真删
 *   node verify-sweep.mjs --title deco       # 额外清 title/tags 含该子串的
 *   node verify-sweep.mjs --all-hex          # 额外只读列出无标记 hex 目录
 *
 * 退出码: 发现残留但未指定 --yes 时返回 1, 便于 CI 卡住"测试环境不干净"。
 *
 * --all-hex 刻意**只列不删**, 原因见上面"刻意不做的事": 无标记 hex 与
 * 用户真实 job 同构, 判定归属需要脚本拿不到的上下文。
 */
import { sweep } from "./verifyHarness.mjs";

const args = process.argv.slice(2);
const tIdx = args.indexOf("--title");

const result = await sweep({
  dryRun: !args.includes("--yes"),
  titleMatch: tIdx >= 0 ? args[tIdx + 1] : null,
  listHex: args.includes("--all-hex"),
});

/**
 * 退出码语义。
 *
 * dry-run 下发现残留也返回 1: 让"环境脏了"这件事在 CI 里变成一个显式信号,
 * 而不是等人某天在画廊里看到 200 张测试照片才发现。
 *
 * 刻意**不**在 dry-run 时打印"清理成功"之类的结论 —— 它什么都没删。
 */
if (result.targets.length && result.deleted.length === 0) {
  console.log("\n发现残留但未执行删除(加 --yes 清理)。");
  process.exitCode = 1;
}
