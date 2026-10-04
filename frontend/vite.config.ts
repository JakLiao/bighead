import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 后端地址可用 BIGHEAD_API_TARGET 覆盖, 避免把端口硬编码在多处。
// 默认值与后端约定端口一致(8077, 不用通用 8000 —— 本机常被其他服务占用),
// 这样忘记设环境变量时也不会静默代理到错误的后端。
const apiTarget = process.env.BIGHEAD_API_TARGET || "http://127.0.0.1:8077";
const wsTarget = apiTarget.replace(/^http/, "ws");

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": apiTarget,
      "/outputs": apiTarget,
      "/ws": { target: wsTarget, ws: true },
    },
  },
});
