import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

/** 模块级常量，保证 plugins 数组引用稳定（内联数组会破坏 memo 效果） */
const REHYPE_PLUGINS = [rehypeSanitize];

/**
 * memo 化的 Markdown 渲染组件。
 *
 * ReactMarkdown 每次渲染都会对输入文本做完整的 parse → sanitize → render，
 * 流式页面高频 setState 时开销随文本长度线性增长。
 * 用 memo 包裹后，仅在 content 变化时重新解析——
 * 配合 ReadingPage 按 section 分段渲染，已完成的 section 不再重复解析。
 */
export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  return <ReactMarkdown rehypePlugins={REHYPE_PLUGINS}>{content}</ReactMarkdown>;
});
