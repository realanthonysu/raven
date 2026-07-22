
# 实施计划：7 项设计模式改进（#2 和 #3 已完成）

## #9 FSRS 魔法数字常量化（P2, Rust）
**文件**: `src-tauri/src/fsrs.rs`

在文件顶部现有常量之后新增：
```rust
// ── Review formula parameters ──
const DIFFICULTY_MIN: f64 = 1.0;
const DIFFICULTY_MAX: f64 = 10.0;
const STABILITY_FLOOR: f64 = 0.1;
const DECAY_FACTOR: f64 = 9.0;
const RETENTION_LOW_THRESHOLD: f64 = 0.5;
const RETENTION_LOW_MULTIPLIER: f64 = 1.2;
const EASY_STABILITY_MULTIPLIER: f64 = 2.5;
const HARD_PENALTY_FACTOR: f64 = 0.5;
const HARD_PENALTY_MIN: f64 = 0.1;
const HARD_SCHEDULED_DAYS_THRESHOLD: i64 = 7;

// ── Mastery thresholds ──
const MASTERED_REPS_GOOD: i64 = 3;
const MASTERED_REPS_HARD: i64 = 5;
```

替换 `review()` 和 `calculate_next_review()` 中的所有硬编码数字。

---

## #4 统一 Settings 白名单（P1, Rust）
**文件**: `src-tauri/src/commands/settings.rs`

合并 `ALLOWED_GENERIC_SETTINGS` 和 `ALLOWED_SETTINGS` 为单一 `ALLOWED_SETTINGS`：
```rust
const ALLOWED_SETTINGS: &[&str] = &[
    // Generic settings
    "onboarding_done", "asr_model",
    "last_backup_time", "last_backup_path",
    "notification_enabled", "last_notification_date",
    "review_notify_time",
    // TTS settings
    "tts_base_url", "tts_model", "tts_voice", "tts_speed",
];
```

两个命令共用此白名单。

---

## #7 位置索引列映射 → 命名列映射（P2, Rust）
**文件**: `src-tauri/src/commands/shared.rs`

将 `row_to_word` 和 `row_to_history` 从 `row.get(0)?` 改为 `row.get("id")?` 等命名访问。rusqlite 支持通过 `&str` 列名访问。

同步更新 `repository/` 下所有使用位置索引的函数（models, export, settings, learning）。

---

## #8 提取 Notes 解析为共享工具（P2, TypeScript）
**文件**: `src/lib/word-utils.ts`, `src/pages/ReviewPage.tsx`, `src/components/VocabularySection.tsx`

将 ReviewPage 的 `parseNotes` 移到 `word-utils.ts`，增强 regex 支持更多中文标签变体（兼容 VocabularySection 的格式）。两个消费者 import 共享版本。

---

## #6 统一 Loading/Error 状态 UI（P1, TypeScript）
**文件**: `src/components/page-states.tsx`, `src/pages/ExercisePage.tsx`, `src/pages/ListeningPage.tsx`, `src/pages/SpeakingPage.tsx`

在 `page-states.tsx` 新增 `<RetryHint>` 组件：
```tsx
export function RetryHint({ show, onRetry }: { show: boolean; onRetry: () => void }) {
  if (!show) return null;
  return (
    <Button variant="link" size="sm" className="text-amber-600 dark:text-amber-400" onClick={onRetry}>
      生成时间较长？重新生成
    </Button>
  );
}
```

三个页面用 `<RetryHint show={showRetryHint} onRetry={handleRetry} />` 替换重复代码。

---

## #5 window.addEventListener → React Context（P1, TypeScript）
**新文件**: `src/contexts/GoalsContext.tsx`
**修改文件**: `src/components/Sidebar.tsx`, `src/pages/settings/GoalCard.tsx`, `src/App.tsx`

创建 `GoalsContext`：
```tsx
export function GoalsProvider({ children }) {
  const [goals, setGoals] = useState<GoalDto[]>([]);
  const refreshGoals = useCallback(async () => {
    const g = await getLearningGoals();
    setGoals(g);
  }, []);
  return <GoalsContext.Provider value={{ goals, refreshGoals }}>{children}</GoalsContext.Provider>;
}
export function useGoals() { return useContext(GoalsContext); }
```

- `App.tsx` 包裹 `<GoalsProvider>`
- `Sidebar.tsx` 用 `useGoals()` 替代 `window.addEventListener`
- `GoalCard.tsx` 用 `refreshGoals()` 替代 `window.dispatchEvent`

---

## #1 Repository Trait 抽象（P0, Rust）
**新文件**: `src-tauri/src/repository/traits.rs`
**修改文件**: `src-tauri/src/repository/mod.rs`

定义读/写两个 trait：
```rust
pub trait ReadRepository {
    fn get_models(&self) -> Result<Vec<ModelDto>, AppError>;
    fn get_default_model(&self) -> Result<Option<ModelDto>, AppError>;
    // ... 所有读函数
}

pub trait WriteRepository: ReadRepository {
    fn add_model(&mut self, model: &NewModelInput) -> Result<i64, AppError>;
    fn delete_model(&self, id: i64) -> Result<(), AppError>;
    // ... 所有写函数
}

impl ReadRepository for rusqlite::Connection { /* 委托给现有自由函数 */ }
impl WriteRepository for rusqlite::Connection { /* 委托给现有自由函数 */ }
```

现有自由函数保持不变（trait impl 委托给它们），Command 层暂不改动（后续可逐步迁移）。

---

## 执行顺序
1. #9 FSRS 常量化
2. #4 Settings 白名单
3. #7 命名列映射
4. #8 Notes 解析提取
5. #6 Loading/UI 组件
6. #5 Goals Context
7. #1 Repository Trait

每步验证编译 + 测试。
