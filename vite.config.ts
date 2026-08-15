import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

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
        // 把大型第三方库拆为独立 chunk：
        // - 稳定依赖与业务代码分离，业务更新时 vendor chunk 缓存仍可命中
        // - recharts/cytoscape/react-markdown 仅在对应懒加载路由首次访问时才拉取
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-charts": ["recharts"],
          "vendor-graph": ["cytoscape"],
          "vendor-markdown": ["react-markdown", "rehype-sanitize"],
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
      ],
      // 阈值基于当前实际覆盖率（68.0/61.2/65.9/68.8）留约 3% 余量，
      // 防止新代码拉低覆盖率；覆盖率提升后应同步上调
      thresholds: {
        statements: 65,
        branches: 58,
        functions: 62,
        lines: 65,
      },
    },
  },
}));
