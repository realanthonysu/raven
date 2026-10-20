/**
 * 单词工具函数 —— 生词本的 enrichment notes 构建和解析、插入/更新载荷工厂、
 * 存在性预检共享件。
 *
 * 提供 notes 字段的格式化写入（buildEnrichmentNotes）和结构化解析（parseNotes），
 * WordLevel 枚举校验（isWordLevel）与归一化（toWordLevel），插入载荷工厂
 * （buildNewWordInput）与更新载荷工厂（buildEnrichmentUpdate），以及补全结果
 * 可用性判定（hasUsableEnrichment / needsEnrichment）、ASCII 小写折叠
 * （asciiLower）与词库存在性预检候选上限（PRECHECK_CANDIDATE_LIMIT）。
 */

import { REVIEW_STATUS } from "@/lib/constants";
import { WordLevelSchema } from "@/lib/schemas";
import type { EnrichedWord, Word, WordLevel } from "@/types";

/** 释义缺失时的占位文案（words 表 definition 列的约定值，enrichWord 失败时保留） */
export const PENDING_DEFINITION = "待补充";

/**
 * 词库存在性预检的候选上限。
 *
 * 取服务端允许的最大值 500（db_get_words 的 limit 在 Rust 侧钳制到 1..=500，
 * 传更大值等效于 500）：预检的代价是一次本地 IPC，而漏判的代价是一次计费的
 * enrichWord LLM 调用（后端 add_word 幂等虽不会产生重复行，但会丢弃本次传入的
 * 全部富化数据），故取上限尽量压缩漏判面；真正的病态候选数（如给单字母词
 * 建存在性检查）由后端幂等兜底，最坏多一次 LLM 调用。
 */
export const PRECHECK_CANDIDATE_LIMIT = 500;

/** 与 SQLite lower() 的 ASCII 语义对齐：仅折叠 A-Z，不改写非 ASCII 字符。 */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

/**
 * 判断单词是否需要 LLM 补全（释义为占位文案或音标缺失）。
 * VocabularyPage 的单个补全按钮与批量补全共用此判定。
 */
export function needsEnrichment(word: Pick<Word, "definition" | "phonetic">): boolean {
  return word.definition === PENDING_DEFINITION || !word.phonetic;
}

/**
 * 补全结果可用性校验：音标与释义去空白后必须均非空。
 *
 * LLM 偶发返回空字段：空 phonetic 经 buildEnrichmentUpdate 会写成空串、
 * 覆盖词库中原有音标，空 definition 则把"待补充"越补越空。故任一为空
 * 即视为补全失败——不写库、计失败，保留原数据交由用户重试。
 * 单个补全、批量补全与 CSV 导入补全三条路径共用此判定。
 */
export function hasUsableEnrichment(
  enriched: Pick<EnrichedWord, "phonetic" | "definition">,
): boolean {
  return enriched.phonetic.trim() !== "" && enriched.definition.trim() !== "";
}

/**
 * 插入载荷工厂：构建 addWord 的入参（Omit<Word, "id" | "created_at">）。
 *
 * 共享 hook（CorrectPage/ReadingPage/SpeakingPage）、手动添加、CSV 导入
 * 三条加词路径共用，避免 8 字段载荷各自内联而随时间漂移：
 * - 可选字段（phonetic/source_text/notes）nullish 统一为 null；
 * - level 经 toWordLevel 归一化（LLM 输出 / 表单值 / CSV 列均属不可信来源，
 *   非法值与 nullish 收敛为 null）；
 * - review_status 固定为 "new"（三条路径均为新词入库）。
 */
export function buildNewWordInput(input: {
  word: string;
  phonetic?: string | null;
  definition: string;
  level?: unknown;
  source_type: Word["source_type"];
  source_text?: string | null;
  notes?: string | null;
}): Omit<Word, "id" | "created_at"> {
  return {
    word: input.word,
    phonetic: input.phonetic ?? null,
    definition: input.definition,
    level: toWordLevel(input.level),
    source_type: input.source_type,
    source_text: input.source_text ?? null,
    notes: input.notes ?? null,
    review_status: REVIEW_STATUS.new,
  };
}

/**
 * 从 LLM 补全结果构建 updateWordEnrichment 的入参。
 * 单个补全、批量补全、CSV 导入补全三条路径共用，避免载荷结构漂移。
 *
 * level 透传 LLM 自动标注的词汇等级：经 toWordLevel 归一化，
 * 越界值（LLM 可能输出 GRE 等 11 值之外的等级）与 nullish 统一为 null。
 * Rust 侧只在现有等级为空时回填，已有等级（手动 / CSV / 先前标注）优先。
 */
export function buildEnrichmentUpdate(enriched: EnrichedWord): {
  phonetic: string;
  definition: string;
  notes: string;
  level: WordLevel | null;
} {
  return {
    phonetic: enriched.phonetic || "",
    definition: enriched.definition || PENDING_DEFINITION,
    notes: buildEnrichmentNotes(enriched) || "",
    level: toWordLevel(enriched.level),
  };
}

/**
 * 从 LLM 补全结果中构建 notes 字段（音标 + 释义 + 搭配 + 例句）。
 *
 * 返回格式示例：
 *   "音标: /wɜːrd/\n释义: 词；单词\n搭配: break the ice\n例句: He broke the ice at the party."
 *
 * 所有字段均为空时返回 null。
 *
 * @param enriched - enrichWord() 返回的结构化数据，或包含相同字段的 VocabEntry
 */
export function buildEnrichmentNotes(
  enriched: Pick<EnrichedWord, "definition" | "collocations" | "example"> & {
    phonetic: string | null;
  },
): string | null {
  return (
    [
      enriched.phonetic && `音标: ${enriched.phonetic}`,
      enriched.definition && `释义: ${enriched.definition}`,
      enriched.collocations && `搭配: ${enriched.collocations}`,
      enriched.example && `例句: ${enriched.example}`,
    ]
      .filter(Boolean)
      .join("\n") || null
  );
}

/**
 * 从单词 notes 字段中解析搭配和例句。
 *
 * 支持 `buildEnrichmentNotes` 写入的标准格式（`搭配: ...` / `例句: ...`），
 * 以及 LLM 生成的变体标签（`常见搭配` / `固定搭配` / `举例` 等）。
 * 冒号兼容全角 `：` 和半角 `:`。
 *
 * @param notes - 单词的 notes 字符串，可为 null
 * @returns 解析出的搭配和例句，未匹配时为 null
 */
export function parseNotes(notes: string | null): {
  collocations: string | null;
  example: string | null;
} {
  if (!notes) return { collocations: null, example: null };
  const collocationsMatch = notes.match(/(?:常见搭配|固定搭配|搭配)[：:]\s*(.+)/);
  const exampleMatch = notes.match(/(?:例句|举例)[：:]\s*(.+)/);
  return {
    collocations: collocationsMatch ? collocationsMatch[1].trim() : null,
    example: exampleMatch ? exampleMatch[1].trim() : null,
  };
}

/**
 * Runtime type guard：校验字符串是否为合法的 WordLevel。
 *
 * 使用 Zod enum schema 校验，替代手写 Set.has 守卫。
 * 用于处理 CSV 导入、表单输入等来自外部的不确定数据。
 * 无效值返回 false，调用方应提供默认值或拒绝。
 *
 * @example
 * ```ts
 * const level = isWordLevel(input) ? input : null;
 * ```
 */
export function isWordLevel(value: string): value is WordLevel {
  return WordLevelSchema.safeParse(value).success;
}

/**
 * 归一化函数：把不确定来源的等级值收敛为合法 WordLevel 或 null。
 *
 * 与 isWordLevel 的分工：isWordLevel 是 type guard（只接受 string），
 * toWordLevel 接受 unknown（LLM 输出 / 解析结果 / undefined），非法值与
 * 非字符串统一归一为 null，供写库前清洗。EnrichedWordSchema.level 是宽松
 * z.string()（LLM 可能越界），写库路径统一经本函数收敛。
 *
 * @example
 * ```ts
 * level: toWordLevel(enriched.level); // "GRE" → null，"CET-4" → "CET-4"
 * ```
 */
export function toWordLevel(value: unknown): WordLevel | null {
  return typeof value === "string" && isWordLevel(value) ? value : null;
}
