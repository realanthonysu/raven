import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
// vite 8 的 UserConfig 不含 `test` 键，官方推荐从 vitest/config 导入 defineConfig
import { defineConfig } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
// 对象直传形式：字面量可获得 contextual typing（provider: "v8" 等）；
// 包在 async 回调里时 TS 对重载调用不传播上下文类型，"v8" 会被放宽为 string 报错
export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // Tauri 运行在 WebView2（Windows）/ WebKit（macOS/Linux）中，
  // 无需兼容旧浏览器，针对现代引擎可减少转译产物体积
  build: {
    // 应用仅面向 Windows 10+（WebView2 / Chromium 内核）；曾保留的 safari13
    // 目标无对应运行环境，反而提升 polyfill 体积
    target: "chrome105",
    rollupOptions: {
      output: {
        // vite 8（rolldown 内核）移除了 manualChunks 对象形式，用等价的
        // codeSplitting.groups 拆分大型第三方库：
        // - 稳定依赖与业务代码分离，业务更新时 vendor chunk 缓存仍可命中
        // - recharts/cytoscape/react-markdown 仅在对应懒加载路由首次访问时才拉取
        // includeDependenciesRecursively 默认 true，捕获模块的依赖一并入组
        // （等价于原对象形式"入口包 + 其依赖"的行为），依赖重复由 priority
        // 与声明顺序仲裁：vendor-react 最先声明，react 系不会被其他组抢走
        codeSplitting: {
          groups: [
            // 通用工具依赖必须在 vendor-charts 之前分组：clsx/tailwind-merge 是
            // cn() 的依赖，use-sync-external-store 是 @base-ui/react 的依赖；
            // 三者也被 recharts 间接依赖。若被 charts 组的
            // includeDependenciesRecursively 捕获，入口/button 会静态依赖整块
            // recharts（~424 KB），懒加载失效。单独成组后首屏只加载共享工具库。
            {
              name: "vendor-utils",
              test: /node_modules[\\/](clsx|tailwind-merge|use-sync-external-store)[\\/]/,
              priority: 4,
            },
            {
              name: "vendor-react",
              test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/,
              priority: 3,
            },
            {
              name: "vendor-charts",
              test: /node_modules[\\/]recharts[\\/]/,
              priority: 2,
            },
            {
              name: "vendor-graph",
              test: /node_modules[\\/]cytoscape[\\/]/,
              priority: 2,
            },
            {
              name: "vendor-markdown",
              test: /node_modules[\\/](react-markdown|rehype-sanitize)[\\/]/,
              priority: 2,
            },
          ],
        },
      },
    },
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 5173,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 5174,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Windows + 32 核机器上默认按核数拉满 fork 池，偶发 worker 异常退出
    // （Vitest 报 "Worker exited unexpectedly"，单测全绿但进程退出码 1）。
    // 限制并发到 4 个 worker：6 秒级测试时长基本不变，跑门禁稳定可复现。
    maxWorkers: 4,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/test/**",
        "src/**/*.test.{ts,tsx}",
        "src/**/*.d.ts",
        "src/main.tsx",
        "src/vite-env.d.ts",
        "src/components/ui/**",
        // 纯类型导出与 barrel 文件无业务逻辑，纳入分母只会无谓拉低覆盖率
        "src/types/**",
        "src/prompts/index.ts",
      ],
      // 阈值基于当前实际覆盖率（83.2/76.0/77.2/84.8）留约 3% 余量，
      // 防止新代码拉低覆盖率；覆盖率提升后应同步上调
      thresholds: {
        statements: 80,
        branches: 72,
        functions: 74,
        lines: 81,
      },
    },
  },
});
