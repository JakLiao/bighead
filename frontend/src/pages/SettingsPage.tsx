import { useEffect, useState } from "react";
import { fetchHealth } from "../api";

export function SettingsPage() {
  const [health, setHealth] = useState<{ ok: boolean; gpu: string; vram_free_gb: number } | null>(null);

  useEffect(() => {
    fetchHealth().then(setHealth);
  }, []);

  return (
    <div className="max-w-3xl mx-auto px-6 py-6 space-y-4">
      <h1 className="font-pixel text-2xl text-brick">设置</h1>

      <div className="bg-white rounded-2xl border-2 border-pink p-5">
        <div className="font-pixel text-sm text-brick mb-3">系统状态</div>
        {health ? (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-brown/70">后端</dt>
            <dd className={health.ok ? "text-green-700" : "text-brick"}>
              {health.ok ? "在线" : "离线"}
            </dd>
            <dt className="text-brown/70">GPU</dt>
            <dd className="font-mono-retro text-base">{health.gpu}</dd>
            <dt className="text-brown/70">显存空闲</dt>
            <dd className="font-mono-retro text-base">{health.vram_free_gb.toFixed(2)} GB</dd>
            <dt className="text-brown/70">显存预算(AI)</dt>
            <dd className="font-mono-retro text-base">≤ 7 GB</dd>
          </dl>
        ) : (
          <div className="text-brown/60 text-sm">加载中...</div>
        )}
      </div>

      <div className="bg-white rounded-2xl border-2 border-pink p-5">
        <div className="font-pixel text-sm text-brick mb-3">关于</div>
        <p className="text-sm text-brown/80 leading-relaxed">
          BigHead 是一个本地运行的大头贴复古应用,完全离线。AI 复古写真是可选功能,
          启用时使用本地 SDXL 模型 + IP-Adapter FaceID 锁定人脸,峰值显存 ≤ 7GB。
          关闭 AI 时不加载任何模型,秒级拼图导出。
        </p>
        <p className="text-sm text-brown/80 mt-3">
          所有模型路径在 <code className="bg-cream px-1 rounded">backend/config.py</code> 配置,
          模型文件位于 webui 共享目录。
        </p>
      </div>

      <div className="bg-white rounded-2xl border-2 border-pink p-5">
        <div className="font-pixel text-sm text-brick mb-3">快捷键</div>
        <ul className="text-sm space-y-1">
          <li><kbd className="px-2 py-0.5 bg-cream border rounded">空格</kbd> — 拍照</li>
          <li><kbd className="px-2 py-0.5 bg-cream border rounded">F11</kbd> — 全屏</li>
          <li><kbd className="px-2 py-0.5 bg-cream border rounded">Esc</kbd> — 退出全屏</li>
        </ul>
      </div>
    </div>
  );
}
