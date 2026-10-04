import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 后端地址可用 BIGHEAD_API_TARGET 覆盖, 避免把端口硬编码在多处。
// 本地同时跑多个实例(或其他项目占用 8000)时尤其有用:
//   $env:BIGHEAD_API_TARGET="http://127.0.0.1:8077"; npm run dev
const apiTarget = process.env.BIGHEAD_API_TARGET || "http://127.0.0.1:8000";
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
