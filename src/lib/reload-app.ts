/**
 * 应用重载 —— 破坏性数据操作（如恢复数据库）后重新初始化全部前端内存态。
 *
 * 恢复数据库后，默认模型缓存、TTS 配置缓存、个性化上下文缓存与级别 store
 * 仍指向旧库的快照，手动逐项失效容易漏；统一重载让所有模块从零 hydration，
 * 彻底消除会话内新旧数据混读。
 *
 * 抽成独立模块（而非在调用处直接 window.location.reload()）：
 * 测试可整体 mock，避免 jsdom 环境触发真实导航。
 */
export function reloadApp(): void {
  window.location.reload();
}
