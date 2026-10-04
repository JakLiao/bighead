import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 审查发现 LiveCamera 曾把 getMask() 的返回值放进 useEffect 依赖 ——
      // 每次渲染都是新对象, 导致 effect 反复重跑并重做全画布 PNG 编码。
      // 这类"不稳定依赖"是本项目最容易复发的坑, 升级为 error 让它无法再溜过去。
      "react-hooks/exhaustive-deps": "error",
      // 倒计时组件在新一轮开始时必须在 effect 里同步重置显示数字, 这是
      // 「由外部 tick 驱动」的固有模式, 不是可以消除的级联渲染。
      "react-hooks/set-state-in-effect": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // 未使用变量有时是有意的(如仅用于类型标注), 降为警告不阻塞构建。
      "@typescript-eslint/no-explicit-any": "off",
    },
  }
);
