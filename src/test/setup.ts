import "@testing-library/jest-dom/vitest";

// jsdom 不实现 ResizeObserver（KnowledgeGraph 用于监听容器尺寸变化）。
// 提供最小 stub：observe/unobserve/disconnect 均为 no-op，不触发回调。
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
