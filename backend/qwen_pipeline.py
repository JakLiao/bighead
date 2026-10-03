"""Qwen-Image-Edit 后端(父进程侧): 托管 .venv-qwen 子进程并暴露 generate_one。

设计要点
--------
1. **为什么是子进程**: Qwen 要 diffusers>=0.40 + transformers>=5.18, 主服务跑在
   webui 的 .venv(diffusers 0.34 / transformers 4.37)。两个版本区间在
   huggingface-hub 上不相交, 同进程共存会直接把 SDXL 也搞坏。所以 Qwen 跑在
   独立解释器里, 这里只做进程托管与管道通信。

2. **常驻而非每次起进程**: 模型加载要 16 秒, 每张图 26 秒。若每张图都重启
   进程, 加载成本会占一半。实测 4 张图: 常驻 102s vs 每次重启 166s。

3. **generate_one 与 SdxlPipeline 同签名**: 这样 pipeline.generate_async
   和前端都不用改 —— 前端零改动的关键就在这里。

4. **输入是「原图」不是「裁好的正方形人脸」**: Qwen 是整图编辑模型, SDXL 那套
   extract_face 裁脸反而会丢掉构图。所以这里接收原始照片, 靠指令保身份。
"""
from __future__ import annotations

import json
import logging
import os
import queue
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from .config import (
    OUTPUT_DIR,
    QWEN_CFG,
    QWEN_LORA_ENABLED,
    QWEN_PYTHON,
    QWEN_SIZE,
    QWEN_STEPS,
    QWEN_WORKER,
)

log = logging.getLogger("bighead.qwen")

_TMP = OUTPUT_DIR / "_qwen_tmp"


class QwenPipeline:
    """Qwen-Image-Edit 推理后端(常驻子进程 + 行 JSON 协议)。"""

    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self._lock = threading.Lock()
        self._lora_layers = 0
        self._booted = False
        self._prewarming = False
        self._prewarm_failed = False
        self._prewarm_error: Exception | None = None
        self._prewarm_cv = threading.Condition()
        # worker 的 stdout 由唯一一条 reader 线程读进这个队列。请求线程只
        # 从队列取, 绝不直接 readline —— 直接 readline 会阻塞, 让超时失效。
        self._rx: queue.Queue = queue.Queue()
        self._rid_counter = 0
        self._worker_pid = 0
        # worker 回传的最近一次峰值显存(GB)。父进程是另一个解释器,
        # 拿不到子进程的 torch.cuda 统计量, 只能靠协议回传 ——
        # generate_async 要把这个值报给前端的显存曲线。
        self.last_peak_gb = 0.0
        self._tmp_count = 0

    # ------------------------------------------------------------------
    # 进程生命周期
    # ------------------------------------------------------------------
    def _spawn(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            return
        if not QWEN_PYTHON.exists():
            raise FileNotFoundError(
                f"Qwen 解释器不存在: {QWEN_PYTHON}\n"
                f"请先创建 .venv-qwen(见 requirements-qwen.txt), "
                f"或用环境变量 BIGHEAD_QWEN_PYTHON 指向已有环境。"
            )
        if not QWEN_WORKER.exists():
            raise FileNotFoundError(f"Qwen worker 不存在: {QWEN_WORKER}")

        log.info("spawning qwen worker: %s", QWEN_PYTHON)
        # 换新队列: 上一个 worker 崩溃时 reader 线程会往队尾塞过一个 None
        # 哨兵。如果复用同一个队列, 新 worker 的第一个回包还没来, 等待方
        # 就会先把那个旧哨兵取出来, 误判成"新 worker 也死了"。
        self._rx = queue.Queue()
        # stderr 单独接出来转发到服务日志: worker 崩溃时 traceback 都在这里,
        # 不接的话父进程只会看到"无响应"这种无信息量的报错。
        self.proc = subprocess.Popen(
            [str(QWEN_PYTHON), "-u", str(QWEN_WORKER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            cwd=str(Path(__file__).resolve().parent.parent),
        )
        self._pump_stderr()
        self._pump_stdout()
        self._booted = False
        self._prewarm_failed = False
        self._prewarm_error = None

    def _pump_stdout(self) -> None:
        """把 worker 的 stdout(协议通道)逐行读进 self._rx。

        必须**只有一条**这样的线程: 多条线程抢同一个 BufferedReader 会把
        行切碎, 制造出"JSON 解析失败"的假故障。
        """
        proc = self.proc
        if proc is None or proc.stdout is None:
            return

        def _run() -> None:
            try:
                for line in proc.stdout:
                    self._rx.put(line)
            except Exception:  # pragma: no cover
                pass
            finally:
                # 哨兵: 让正在等回包的线程立刻知道 worker 没了,
                # 而不是傻等到超时。
                self._rx.put(None)

        threading.Thread(target=_run, daemon=True, name="qwen-stdout").start()

    def _pump_stderr(self) -> None:
        """把 worker 的 stderr 逐行转到服务日志(后台线程)。"""
        proc = self.proc
        if proc is None or proc.stderr is None:
            return

        def _run() -> None:
            try:
                for line in proc.stderr:
                    line = line.rstrip()
                    if line:
                        log.info("[qwen] %s", line)
            except Exception:  # pragma: no cover
                pass

        threading.Thread(target=_run, daemon=True, name="qwen-stderr").start()

    def _rpc(self, req: dict, timeout: float = 1800.0) -> dict:
        """发一条请求并等它的回包。调用方必须已持有 self._lock。

        为什么用 rid 而不是 event 名来匹配回包:
        worker 有两类输出 —— 主动推送(boot)和对请求的应答。如果靠 event 名
        判断, "ready" 到底是通知还是应答就分不清了。之前正是把 warmup 的
        应答当成通知跳过了, 然后继续 readline 一直阻塞到超时。

        为什么必须有独立 reader 线程:
        proc.stdout.readline() 是**阻塞**调用, 在主线程里调它, 下面那行
        `if time.time() - t_start > timeout` 永远没机会执行 —— 超时形同虚设。
        实测过一次: worker 早就崩了, 父进程仍然傻等满 1800s。
        """
        self._spawn()
        assert self.proc is not None and self.proc.stdin is not None
        self._rid_counter += 1
        rid = f"{self._rid_counter:x}"
        req = {**req, "rid": rid}
        try:
            self.proc.stdin.write(json.dumps(req, ensure_ascii=False) + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            raise RuntimeError(f"Qwen worker 已断开({e}), 下次调用会重启") from e

        seen: list[str] = []
        noise: list[str] = []
        t_start = time.time()
        while True:
            try:
                line = self._rx.get(timeout=0.5)
            except queue.Empty:
                if time.time() - t_start > timeout:
                    tail = "\n".join(seen[-12:]) if seen else "(一行都没读到)"
                    raise TimeoutError(
                        f"Qwen worker {timeout:.0f}s 未回包(rid={rid})。"
                        f"已读到 {len(seen)} 行:\n{tail}"
                    )
                continue

            if line is None:
                tail = "\n".join(seen[-12:]) if seen else "(一行都没读到)"
                raise RuntimeError(
                    f"Qwen worker 无响应(EOF, 进程可能已崩溃)。已读到:\n{tail}"
                )

            line = line.strip()
            if not line:
                continue
            seen.append(line[:300])
            if len(seen) > 400:
                # 防第三方库(如进度条)疯狂刷屏把内存吃光
                del seen[:200]

            if not line.startswith("{"):
                # 理论上不该有: worker 已把 sys.stdout 重定向到 stderr。
                # 真出现了说明有东西绕过 Python 直接写 fd 1, 记下来便于排查,
                # 但绝不能让它进入协议解析。
                noise.append(line[:200])
                continue
            try:
                resp = json.loads(line)
            except Exception:
                noise.append(line[:200])
                continue

            got_rid = resp.get("rid")
            if not got_rid:
                # 主动推送(boot)。只更新状态, 不当作任何请求的应答。
                if resp.get("event") == "boot":
                    self._worker_pid = int(resp.get("pid") or 0)
                    log.info("qwen worker 已启动, pid=%s", resp.get("pid"))
                continue
            if got_rid != rid:
                # 迟到的上一次请求的应答(比如上一次超时了但 worker 仍在跑完)。
                noise.append(f"[stale rid={got_rid}] {line[:180]}")
                continue

            if resp.get("event") == "ready":
                self._booted = True
                self._lora_layers = int(resp.get("lora_layers") or 0)
            if resp.get("lora_layers"):
                self._lora_layers = int(resp["lora_layers"])

            if not resp.get("ok", False):
                extra = f"\ntrace: {resp['trace']}" if resp.get("trace") else ""
                raise RuntimeError(
                    f"Qwen 生成失败: {resp.get('error')}{extra}\n"
                    + ("\nworker 输出:\n" + "\n".join(seen[-8:]) if seen else "")
                )
            return resp

    def ensure_ready(self, wait: bool = True) -> bool:
        """确保 worker 已加载并预热完成。

        加载 75s + 首次 CUDA 懒加载 145s ≈ **3.5 分钟**。这个开销必须提前
        吃掉, 不能让第一个用户请求去承担。所以服务启动时会后台调
        `prewarm()`(wait=False), 之后用户请求走 wait=True 快速路径。

        实测:
            模型加载          75.5s
            首次推理(懒加载) 144.5s
            稳态每张          27~28s
        """
        if self._booted:
            return True
        if self._prewarming:
            if not wait:
                return False
            # 已在预热: 等它结束, 而不是重复发起
            with self._prewarm_cv:
                while not self._booted and not self._prewarm_failed:
                    self._prewarm_cv.wait(timeout=5.0)
            return self._booted

        self._prewarming = True
        try:
            t0 = time.time()
            log.info(
                "qwen worker 启动中(加载 ~75s + 首次预热 ~145s, 共约 3.5 分钟)..."
            )
            with self._lock:
                self._rpc({"op": "warmup"}, timeout=1800.0)
            self._booted = True
            log.info(
                "qwen worker 就绪(耗时 %.1fs, LoRA 层数=%d)",
                time.time() - t0, self._lora_layers,
            )
            if self._lora_layers == 0:
                log.warning(
                    "Lightning LoRA 未挂上(lora_layers=0)。"
                    "4 步 + CFG 1.0 离开 LoRA 会退化成几乎不改图。"
                )
        except Exception as e:
            self._prewarm_failed = True
            self._prewarm_error = e
            log.error("qwen worker 启动失败: %s", e)
            raise
        finally:
            self._prewarming = False
            with self._prewarm_cv:
                self._prewarm_cv.notify_all()
        return self._booted

    def prewarm(self) -> None:
        """后台预热(服务启动时调用, 不阻塞启动)。"""
        if self._booted or self._prewarming:
            return
        th = threading.Thread(target=self._safe_prewarm, daemon=True, name="qwen-prewarm")
        th.start()

    def _safe_prewarm(self) -> None:
        try:
            self.ensure_ready(wait=True)
        except Exception:
            pass    # 已记录; 真正的错误会在用户请求时重新抛出

    def shutdown(self) -> None:
        with self._lock:
            if self.proc is None:
                return
            try:
                self._rpc({"op": "shutdown"}, timeout=30.0)
            except Exception:
                pass
            try:
                self.proc.terminate()
                self.proc.wait(timeout=10)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
            self.proc = None
            self._booted = False
            self._prewarming = False
            self._prewarm_failed = False
            self._prewarm_error = None
            with self._prewarm_cv:
                self._prewarm_cv.notify_all()

    # ------------------------------------------------------------------
    # 生成
    # ------------------------------------------------------------------
    def generate_one(
        self,
        face_pil,
        style: dict,
        backbone: str | None = None,
        steps: int | None = None,
        faceid_scale: float | None = None,
        size: tuple[int, int] | None = None,
        faceid_embeds=None,
        seed: int | None = None,
    ):
        """生成单张图, 返回 PIL.Image。签名与 SdxlPipeline.generate_one 一致。

        参数里 backbone / faceid_scale / faceid_embeds 是为兼容 SDXL 的调用方
        而存在的, Qwen 这条路上全部忽略 —— 它靠「原图 + 编辑指令」保身份,
        不需要 FaceID embedding 投影。

        face_pil 在这里是**原始照片**而不是裁脸方图(见 generate_async 的处理)。
        """
        from PIL import Image

        del backbone, faceid_scale, faceid_embeds  # Qwen 路线不用

        if not QWEN_LORA_ENABLED:
            raise RuntimeError(
                "Qwen 路线必须挂 Lightning 4 步 LoRA: 4 步 + CFG 1.0 是蒸馏"
                "配对用法, 离开 LoRA 会几乎不改图(实测)。"
                "若要回退 SDXL, 请设 BIGHEAD_AI_BACKEND=sdxl。"
            )

        prompt = style.get("qwen_prompt") or style.get("prompt_prefix") or ""
        if not prompt:
            raise ValueError("style 缺少 qwen_prompt")

        self.ensure_ready(wait=True)

        _TMP.mkdir(parents=True, exist_ok=True)
        stem = f"{uuid.uuid4().hex[:12]}"
        in_path = _TMP / f"{stem}_in.jpg"
        out_path = _TMP / f"{stem}_out.jpg"
        img = face_pil if isinstance(face_pil, Image.Image) else Image.open(face_pil)
        img = img.convert("RGB")

        w, h = size or QWEN_SIZE

        # 超大输入先降采样再落盘, 避免 4K 原图把内存打爆。
        # 为什么要这一步: 早期版本为「不损失脸部细节」直接存全尺寸, 对
        # 1280x720 是对的; 但手机直出的照片动辄 3840x3072(实测这台机器上),
        # 存全图 + worker 载入 + 模型常驻会一起把 CPU 内存顶穿, 报
        # "DefaultCPUAllocator: not enough memory"(实测 4K 输入下第 2 张就崩)。
        #
        # 降采样不损失有效信息: 目标输出只有 512x768, 裁切框再大,
        # 真正进入模型的也只有 512x768 像素。把 3840 缩到 1600 宽,
        # 相当于给裁切留了 3 倍余量, 脸部细节远够用。
        # 阈值取 1600px 宽(约 4MP), 对 1280x720 的输入完全不动。
        _MAX_W = 1600
        if img.width > _MAX_W:
            _scale = _MAX_W / float(img.width)
            img = img.resize(
                (int(round(img.width * _scale)),
                 int(round(img.height * _scale))),
                Image.LANCZOS,
            )
            log.info("输入图 %dx%d 过大, 已降采样到 %dx%d",
                     face_pil.width if hasattr(face_pil, "width") else 0,
                     face_pil.height if hasattr(face_pil, "height") else 0,
                     img.width, img.height)
        img.save(in_path, quality=95)

        # 人脸感知的裁切框: 横图裁成竖图时, 居中裁会把画面边缘的人切掉
        # (实测 1280x720 合照裁 2:3 只保留横向 38%, 左边的人被劈成半张脸)。
        # 父进程有 insightface, worker 没有, 所以在这里算好传下去。
        # 注意裁切框是在**降采样后**的图上算的, 必须与传给 worker 的图同尺寸。
        crop_box = None
        try:
            from .face import face_aware_crop_box

            crop_box = face_aware_crop_box(img, int(w), int(h))
        except Exception as e:
            # 检不到脸 / insightface 异常都退回居中裁切, 不该因此失败
            log.debug("face_aware_crop_box 不可用, 退回居中裁切: %s", e)

        req = {
            "op": "gen",
            "img": str(in_path),
            "out": str(out_path),
            "prompt": prompt,
            "steps": int(steps or QWEN_STEPS),
            "cfg": QWEN_CFG,
            "w": int(w),
            "h": int(h),
            "crop_box": list(crop_box) if crop_box else None,
            "seed": int(seed) if seed is not None else int.from_bytes(os.urandom(4), "big"),
        }

        try:
            with self._lock:
                resp = self._rpc(req)
        finally:
            in_path.unlink(missing_ok=True)

        log.info(
            "qwen gen %.1fs peak=%.2fGB -> %s",
            resp.get("seconds", 0.0), resp.get("peak_gb", 0.0), out_path.name,
        )
        self.last_peak_gb = float(resp.get("peak_gb") or 0.0)
        result = Image.open(out_path).convert("RGB")
        # out_path 留着: 调用方拿到的是内存里的像素, 但异常路径下需要留档
        # 便于排查; 累计到一定数量后由 cleanup_tmp 清掉。
        self._tmp_count += 1
        if self._tmp_count > 20:
            self.cleanup_tmp(keep=4)
        return result

    def cleanup_tmp(self, keep: int = 0) -> None:
        """清临时目录(keep>0 时保留最近 keep 个, 避免删掉还没存完的)。"""
        if not _TMP.exists():
            return
        try:
            files = sorted(_TMP.glob("*.jpg"), key=lambda p: p.stat().st_mtime)
            for p in files[: max(0, len(files) - keep)]:
                p.unlink(missing_ok=True)
        except Exception as e:  # pragma: no cover
            log.debug("cleanup tmp failed: %s", e)


# 全局单例(与 pipeline.pipeline 同级)
qwen_pipeline = QwenPipeline()

if __name__ == "__main__":  # 手动自检: python -m backend.qwen_pipeline
    logging.basicConfig(level=logging.INFO)
    src = OUTPUT_DIR / "1a0b12477d66" / "photo_1.jpg"
    if not src.exists():
        print(f"找不到测试图 {src}")
        sys.exit(1)
    from PIL import Image

    t0 = time.time()
    im = qwen_pipeline.generate_one(
        Image.open(src), {"qwen_prompt": "把这张人像照片处理成复古大头贴风格, 保持人物身份不变。"},
        seed=42,
    )
    dst = OUTPUT_DIR / "_qwen_tmp" / "selftest.jpg"
    im.save(dst, quality=92)
    print(f"OK  {time.time() - t0:.1f}s  ->  {dst}")
    qwen_pipeline.shutdown()
