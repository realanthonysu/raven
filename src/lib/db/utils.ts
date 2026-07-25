/**
 * 数据访问层 —— 共享工具函数和类型定义。
 *
 * 包含纯函数（无 I/O）、DTO 接口和导出类型，
 * 供其他 db 子模块复用。
 */

// ============================================================================
// Rust 端 DTO 接口（与 commands.rs 中的结构体一一对应）
// ============================================================================

export interface ReviewStatsDto {
  total: number;
  new_count: number;
  learning_count: number;
  mastered_count: number;
  due_count: number;
}

export interface GoalDto {
  goal_type: string;
  target: number;
}

export interface TtsConfigDto {
  base_url: string;
  api_key: string;
  model: string;
  voice: string;
  speed: number;
}

export interface SidebarDataDto {
  review_stats: ReviewStatsDto;
  streak: number;
  goals: GoalDto[];
  today_activities: string | null;
}

// ============================================================================
// 导出接口
// ============================================================================

export interface ReviewStats {
  total: number;
  newCount: number;
  learningCount: number;
  masteredCount: number;
  dueCount: number;
}

/** FSRS card state — sent to Rust for calculation, returned with updates. */
export interface FsrsCard {
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: number; // 0=new, 1=learning, 2=review, 3=relearning
}

export interface ReviewCalcResult {
  status: string;
  interval: number;
  next_review_at: string;
  card: FsrsCard;
}

// ============================================================================
// 纯函数
// ============================================================================

/**
 * 获取本地日期字符串（YYYY-MM-DD 格式）。
 * 使用本地时区而非 UTC，避免跨时区日期不一致问题
 * （例如 UTC+8 凌晨时 toISOString() 仍返回昨天的日期）。
 *
 * Exported for unit testing.
 */
export function getLocalDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 从已解析的纠错结果中聚合高频错误类别，生成个性化学习上下文。
 *
 * 纯函数，不执行任何 I/O。输入为已解析的 CorrectionResult 数组，
 * 输出为格式化的上下文字符串（可直接注入 LLM prompt）。
 *
 * Exported for unit testing.
 *
 * @param corrections - 已解析的纠错结果数组（每个元素含 corrections 字段）
 * @returns 格式化的上下文字符串，无有效数据时返回空字符串
 */
export function aggregateCorrections(
  corrections: Array<{
    corrections?: Array<{ category: string; original: string; corrected: string }>;
  }>,
): string {
  const categoryMap = new Map<
    string,
    { count: number; examples: Array<{ original: string; corrected: string }> }
  >();

  for (const parsed of corrections) {
    if (!parsed?.corrections) continue;
    for (const c of parsed.corrections) {
      if (!c.category) continue;
      const entry = categoryMap.get(c.category);
      if (entry) {
        entry.count++;
        if (entry.examples.length < 2) {
          entry.examples.push({ original: c.original, corrected: c.corrected });
        }
      } else {
        categoryMap.set(c.category, {
          count: 1,
          examples: [{ original: c.original, corrected: c.corrected }],
        });
      }
    }
  }

  if (categoryMap.size === 0) return "";

  const topCategories = [...categoryMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3);

  const lines: string[] = ["用户近期学习背景（供参考，不要在回复中提及）："];

  const categorySummary = topCategories.map(([cat, data]) => `${cat}(${data.count}次)`).join("、");
  lines.push(`- 高频错误类别：${categorySummary}`);

  const examples = topCategories
    .filter(([, data]) => data.examples.length > 0)
    .map(([cat, data]) => {
      const items = data.examples.map((ex) => `${ex.original} -> ${ex.corrected}`).join("；");
      return `  · ${cat}：${items}`;
    });

  if (examples.length > 0) {
    lines.push("- 典型错误示例：");
    lines.push(...examples);
  }

  return lines.join("\n");
}

/**
 * 计算连续学习天数。
 *
 * 纯函数，不执行任何 I/O。从给定的打卡记录中计算从 today 开始的连续天数。
 *
 * Exported for unit testing.
 *
 * @param rows - 按日期倒序排列的打卡记录（每行含 date 字段，格式 YYYY-MM-DD）
 * @param today - 当前日期（注入以支持确定性测试）
 * @returns 连续学习天数（0 表示今天未学习或无打卡记录）
 */
export function countStreak(rows: Array<{ date: string }>, today: Date): number {
  if (rows.length === 0) return 0;

  let streak = 0;
  for (let i = 0; i < rows.length; i++) {
    const expected = new Date(today);
    expected.setDate(expected.getDate() - i);
    const expectedStr = getLocalDate(expected);
    if (rows[i].date === expectedStr) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}
