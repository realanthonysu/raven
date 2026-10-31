/**
 * VocabularyPage component-level tests.
 *
 * Mocks db functions (getWordsPage / getWordStats / deleteWord / updateWordLevel / ...),
 * SpeakButton, and LLM enrichment service. 导出走 Rust 侧
 * writeTextFileDialog（原生保存对话框），不再经过前端 dialog 插件。
 *
 * 分页契约：列表加载走 getWordsPage（limit/offset/search/level），分级统计走
 * getWordStats 聚合；删除/改等级/单条补全后只做局部更新，不再全量 getWords()。
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Word } from "@/types";

import VocabularyPage from "./VocabularyPage";

// ─── Module mocks ─────────────────────────────────────────────────

// 部分 mock：IPC 函数替换为 vi.fn()，getLocalDate 等纯函数走真实实现——
// 导出文件名的本地日期语义若漂移，本测试第一时间可见
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getWords: vi.fn().mockResolvedValue([]),
  getWordsPage: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  getWordStats: vi.fn().mockResolvedValue([]),
  addWordsBatch: vi.fn().mockResolvedValue([]),
  deleteWord: vi.fn().mockResolvedValue(undefined),
  updateWordLevel: vi.fn().mockResolvedValue(undefined),
  updateWordEnrichment: vi.fn().mockResolvedValue(undefined),
  addWord: vi.fn().mockResolvedValue({ lastInsertId: 99 }),
  exportWordsCsv: vi.fn().mockResolvedValue("word,phonetic\nhello,/həˈloʊ/"),
  exportWordsAnki: vi.fn().mockResolvedValue("hello\t/həˈloʊ/\t你好"),
  writeTextFileDialog: vi.fn().mockResolvedValue("C:\\exports\\raven-words.csv"),
}));

vi.mock("@/components/SpeakButton", () => ({
  SpeakButton: () => null,
}));

vi.mock("@/services/vocabulary-enrichment", () => ({
  enrichWord: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/csv-utils", () => ({
  parseCsvLine: (line: string) => line.split(","),
}));

// ─── Test fixtures ────────────────────────────────────────────────

const sampleWords: Word[] = [
  {
    id: 1,
    word: "ephemeral",
    phonetic: "/ɪˈfemərəl/",
    definition: "短暂的，转瞬即逝的",
    level: "CET-6",
    source_type: "reading",
    source_text: "Fame is ephemeral.",
    notes: "搭配: ephemeral beauty\n例句: Fame is ephemeral.",
    review_status: "learning",
    review_count: 3,
    next_review_at: "2026-08-01T00:00:00",
    created_at: "2026-01-01T00:00:00",
  },
  {
    id: 2,
    word: "ubiquitous",
    phonetic: "/juːˈbɪkwɪtəs/",
    definition: "无处不在的",
    level: "TEM-4",
    source_type: "correct",
    source_text: "Smartphones are ubiquitous.",
    notes: null,
    review_status: "new",
    review_count: 0,
    next_review_at: null,
    created_at: "2026-01-02T00:00:00",
  },
  {
    id: 3,
    word: "resilience",
    phonetic: null,
    definition: "待补充",
    level: null,
    source_type: "manual",
    source_text: null,
    notes: null,
    review_status: "new",
    review_count: 0,
    next_review_at: null,
    created_at: "2026-01-03T00:00:00",
  },
];

/** 构造 getWordsPage 的响应 */
function pageOf(items: Word[], total = items.length) {
  return { items, total };
}

/** getWordsPage 的服务端过滤/分页模拟（搜索 + 等级筛选 + offset/limit） */
function pageResponder(all: Word[]) {
  return (opts: { limit: number; offset?: number; search?: string; level?: string | null }) => {
    const kw = (opts.search ?? "").toLowerCase();
    const filtered = all.filter(
      (w) => (!kw || w.word.toLowerCase().includes(kw)) && (!opts.level || w.level === opts.level),
    );
    const offset = opts.offset ?? 0;
    return Promise.resolve({
      items: filtered.slice(offset, offset + opts.limit),
      total: filtered.length,
    });
  };
}

// ─── Helpers ──────────────────────────────────────────────────────

function renderVocabularyPage() {
  return render(
    <MemoryRouter initialEntries={["/vocabulary"]}>
      <VocabularyPage />
    </MemoryRouter>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────

describe("VocabularyPage", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 删除二次确认：jsdom 的 confirm 默认返回 false 会拦截删除操作
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    // 每个测试重置默认桩：空词库 / 空统计
    const db = await import("@/lib/db");
    vi.mocked(db.getWordsPage).mockResolvedValue(pageOf([]));
    vi.mocked(db.getWordStats).mockResolvedValue([]);
    vi.mocked(db.getWords).mockResolvedValue([]);
    vi.mocked(db.addWordsBatch).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Page title ──

  it("renders page title", async () => {
    renderVocabularyPage();
    expect(screen.getByRole("heading", { name: /生词本/ })).toBeInTheDocument();
  });

  // ── Empty state ──

  it("shows empty state when no words", async () => {
    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText(/生词本暂无词汇/)).toBeInTheDocument();
    });

    expect(screen.getByText(/手动添加、导入 CSV/)).toBeInTheDocument();
    // 无词时分级掌握度卡片整体隐藏（不渲染空卡片）
    expect(screen.queryByText("分级掌握度")).not.toBeInTheDocument();
  });

  // ── Word list ──

  it("renders word list when data is loaded", async () => {
    const { getWordsPage } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockResolvedValueOnce(pageOf(sampleWords));

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
      expect(screen.getByText("ubiquitous")).toBeInTheDocument();
      expect(screen.getByText("resilience")).toBeInTheDocument();
    });

    // Should display phonetic for words that have it
    expect(screen.getByText("/ɪˈfemərəl/")).toBeInTheDocument();
    expect(screen.getByText("/juːˈbɪkwɪtəs/")).toBeInTheDocument();

    // Should display definitions
    expect(screen.getByText("短暂的，转瞬即逝的")).toBeInTheDocument();
    expect(screen.getByText("无处不在的")).toBeInTheDocument();

    // Should show word count
    expect(screen.getByText(/共 3 个单词/)).toBeInTheDocument();
  });

  it("renders level badges for words that have levels", async () => {
    const { getWordsPage } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockResolvedValueOnce(pageOf(sampleWords));

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    // CET-6 badge for ephemeral
    const cet6Badges = screen.getAllByText("CET-6");
    expect(cet6Badges.length).toBeGreaterThanOrEqual(1);

    // TEM-4 badge for ubiquitous
    const tem4Badges = screen.getAllByText("TEM-4");
    expect(tem4Badges.length).toBeGreaterThanOrEqual(1);
  });

  it("renders level mastery stats (count + review distribution) for marked and unmarked words", async () => {
    // 分级掌握度来自 getWordStats 的聚合结果，而不是全量词表快照。
    const { getWordsPage, getWordStats } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockResolvedValueOnce(pageOf(sampleWords));
    vi.mocked(getWordStats).mockResolvedValueOnce([
      { level: "CET-6", review_status: "learning", count: 1 },
      { level: "TEM-4", review_status: "new", count: 1 },
      { level: null, review_status: "new", count: 1 },
    ]);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("分级掌握度")).toBeInTheDocument();
    });

    expect(screen.getByText(/1 词 · 新0 学1 掌0/)).toBeInTheDocument();
    expect(screen.getAllByText(/1 词 · 新1 学0 掌0/)).toHaveLength(2);
    expect(screen.getByText("未标记")).toBeInTheDocument();
  });

  it("renders notes when available", async () => {
    const { getWordsPage } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockResolvedValueOnce(pageOf(sampleWords));

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText(/ephemeral beauty/)).toBeInTheDocument();
    });
  });

  // ── Delete word（局部更新，不重新拉取列表）──

  it("can delete a word and updates the list locally without a full refetch", async () => {
    const { getWordsPage, getWordStats, deleteWord, getWords } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockResolvedValueOnce(pageOf(sampleWords));
    vi.mocked(deleteWord).mockResolvedValue(undefined);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    const pageCallsBefore = vi.mocked(getWordsPage).mock.calls.length;

    // Find all delete buttons (Trash2 icon buttons) and click the first one
    const deleteButtons = screen.getAllByRole("button").filter((btn) => {
      // Delete buttons are ghost variant icon buttons in the word list
      return btn.querySelector("svg") && btn.className.includes("h-8 w-8");
    });

    expect(deleteButtons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(deleteWord).toHaveBeenCalledWith(1);
    });
    await waitFor(() => {
      expect(screen.queryByText("ephemeral")).not.toBeInTheDocument();
    });

    // 删除后局部更新：不重新拉取列表，也不再调用全量 getWords()
    expect(vi.mocked(getWordsPage).mock.calls.length).toBe(pageCallsBefore);
    expect(getWords).not.toHaveBeenCalled();
    // 统计聚合刷新一次（挂载一次 + 删除后一次）
    expect(getWordStats).toHaveBeenCalledTimes(2);
  });

  // ── Search / filter（全部下推服务端）──

  it("filters words by search input through getWordsPage", async () => {
    const { getWordsPage } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockImplementation(pageResponder(sampleWords));

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/搜索单词/);
    fireEvent.change(searchInput, { target: { value: "ephem" } });

    await waitFor(() => {
      expect(getWordsPage).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100, search: "ephem", level: null }),
      );
    });
    // 服务端返回过滤后的结果(仅 ephemeral 匹配)
    await waitFor(() => {
      expect(screen.queryByText("ubiquitous")).not.toBeInTheDocument();
      expect(screen.queryByText("resilience")).not.toBeInTheDocument();
      expect(screen.getByText(/共 1 个单词/)).toBeInTheDocument();
    });
  });

  it("pushes level filter down to getWordsPage", async () => {
    const { getWordsPage } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockImplementation(pageResponder(sampleWords));

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    // Click the TEM-4 filter button (in the filter bar, not the per-word level buttons)
    const filterButtons = screen.getAllByRole("button", { name: "TEM-4" });
    fireEvent.click(filterButtons[0]);

    await waitFor(() => {
      expect(getWordsPage).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100, search: undefined, level: "TEM-4" }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText("ephemeral")).not.toBeInTheDocument();
      expect(screen.getByText("ubiquitous")).toBeInTheDocument();
      expect(screen.getByText(/共 1 个单词/)).toBeInTheDocument();
    });
  });

  it("clears level filter when clicking the same level again", async () => {
    const { getWordsPage } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockImplementation(pageResponder(sampleWords));

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    // Apply CET-6 filter
    fireEvent.click(screen.getAllByRole("button", { name: "CET-6" })[0]);
    await waitFor(() => {
      expect(screen.getByText(/共 1 个单词/)).toBeInTheDocument();
    });

    // Click CET-6 again to clear filter
    fireEvent.click(screen.getAllByRole("button", { name: "CET-6" })[0]);
    await waitFor(() => {
      expect(screen.getByText(/共 3 个单词/)).toBeInTheDocument();
    });
    expect(getWordsPage).toHaveBeenCalledWith(expect.objectContaining({ level: null }));
  });

  it("loads the first page exactly once on mount", async () => {
    // 回归：挂载 effect 与防抖 effect 曾各发一次相同的查询。合并为单一 effect 后，
    // 推进过防抖窗口仍应只有一次 getWordsPage。
    const { getWordsPage, getWordStats, getWords } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockResolvedValue(pageOf(sampleWords));

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve();
    });

    expect(getWordsPage).toHaveBeenCalledTimes(1);
    expect(getWordsPage).toHaveBeenCalledWith({ limit: 100, search: undefined, level: null });
    expect(getWordStats).toHaveBeenCalledTimes(1);
    expect(getWords).not.toHaveBeenCalled();
  });

  it("loads the next page and appends it (显示更多)", async () => {
    const moreWords: Word[] = [4, 5, 6].map((id) => ({
      ...sampleWords[0],
      id,
      word: `word-${id}`,
    }));
    const { getWordsPage } = await import("@/lib/db");
    vi.mocked(getWordsPage)
      .mockResolvedValueOnce(pageOf(sampleWords, 150))
      .mockResolvedValueOnce(pageOf(moreWords, 150));

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText(/显示更多（已显示 3 \/ 150）/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /显示更多/ }));

    await waitFor(() => {
      expect(getWordsPage).toHaveBeenCalledWith({
        limit: 100,
        offset: 3,
        search: undefined,
        level: null,
      });
    });
    await waitFor(() => {
      expect(screen.getByText("word-4")).toBeInTheDocument();
      expect(screen.getByText(/显示更多（已显示 6 \/ 150）/)).toBeInTheDocument();
    });
  });

  it("clears a word's level when clicking its current level again", async () => {
    // 注释与行为对齐：点击单词当前已选中的等级 → 传空串清空等级
    // （Rust 侧 update_word_level 支持空串清空）
    const { getWordsPage, updateWordLevel } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockResolvedValue(pageOf(sampleWords));
    vi.mocked(updateWordLevel).mockResolvedValue(undefined);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    const pageCallsBefore = vi.mocked(getWordsPage).mock.calls.length;

    // 区分顶部筛选按钮（size sm，无 h-6）与词卡片上的等级按钮（h-6）；
    // 词卡片按 words 顺序渲染，第一个即 ephemeral（已标记 CET-6）
    const wordLevelCet6Buttons = screen
      .getAllByRole("button", { name: "CET-6" })
      .filter((btn) => btn.className.includes("h-6"));
    fireEvent.click(wordLevelCet6Buttons[0]);

    await waitFor(() => {
      expect(updateWordLevel).toHaveBeenCalledWith(1, "");
    });
    // 局部更新：不重新拉取列表
    expect(vi.mocked(getWordsPage).mock.calls.length).toBe(pageCallsBefore);
  });

  it("shows no-match message when search has no results", async () => {
    const { getWordsPage } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockImplementation(pageResponder(sampleWords));

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/搜索单词/);
    fireEvent.change(searchInput, { target: { value: "xyznotfound" } });

    // 推进防抖定时器并 flush Promise 微任务(act 内),触发服务端搜索与状态更新
    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText(/没有匹配的单词/)).toBeInTheDocument();
    });
  });

  // ── Error handling ──

  it("shows error banner on load failure", async () => {
    const { getWordsPage } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockRejectedValueOnce(new Error("数据库连接失败"));

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText(/数据库连接失败/)).toBeInTheDocument();
    });
  });

  // ── Manual add form ──

  it("toggles manual add form open/closed", async () => {
    renderVocabularyPage();

    // The form header (CardTitle) should be clickable
    const formHeaders = screen.getAllByText("手动添加");
    expect(formHeaders.length).toBeGreaterThanOrEqual(1);
    const formHeader = formHeaders[0];

    // Form inputs should not be visible initially
    expect(screen.queryByPlaceholderText(/输入英文单词/)).not.toBeInTheDocument();

    // Click to open
    fireEvent.click(formHeader);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/输入英文单词/)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/fəˈnetɪk/)).toBeInTheDocument();
    });

    // Click again to close
    fireEvent.click(formHeader);

    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/输入英文单词/)).not.toBeInTheDocument();
    });
  });

  // ── Export（E8：Rust 侧对话框）──

  it("names the export file with the local date, not the UTC date (C2 regression)", async () => {
    // 回归：默认文件名曾用 toISOString().slice(0,10) 取 UTC 日期——
    // UTC+8 用户本地凌晨 0-8 点导出会得到昨天（与 BackupCard 的本地日期命名不一致）
    vi.setSystemTime(new Date(2026, 9, 14, 2, 0, 0)); // 本地 2026-10-14 02:00
    const { getWordsPage, getLocalDate, writeTextFileDialog } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockResolvedValueOnce(pageOf(sampleWords));

    renderVocabularyPage();
    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("导出 CSV"));

    await waitFor(() => {
      expect(vi.mocked(writeTextFileDialog)).toHaveBeenCalled();
    });
    // 此刻本地日期是 2026-10-14，UTC 日期是 2026-10-13
    expect(getLocalDate()).toBe("2026-10-14");
    expect(vi.mocked(writeTextFileDialog)).toHaveBeenCalledWith(
      "raven-words-2026-10-14.csv",
      "csv",
      "word,phonetic\nhello,/həˈloʊ/",
    );
  });

  it("exports through the Rust-side dialog and confirms success", async () => {
    const { getWordsPage, writeTextFileDialog } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockResolvedValueOnce(pageOf(sampleWords));

    renderVocabularyPage();
    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("导出 CSV"));

    await waitFor(() => {
      expect(screen.getByText("CSV 导出成功")).toBeInTheDocument();
    });
    expect(vi.mocked(writeTextFileDialog)).toHaveBeenCalledWith(
      expect.stringMatching(/^raven-words-\d{4}-\d{2}-\d{2}\.csv$/),
      "csv",
      expect.any(String),
    );
  });

  it("stays silent when the export dialog is cancelled", async () => {
    const { getWordsPage, writeTextFileDialog } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockResolvedValueOnce(pageOf(sampleWords));
    // 用户取消：Rust 侧返回 null
    vi.mocked(writeTextFileDialog).mockResolvedValueOnce(null);

    renderVocabularyPage();
    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("导出 Anki"));

    // 等待 finally 复位 exporting（按钮文字恢复）后仍不应出现任何反馈消息
    await waitFor(() => {
      expect(screen.getByText("导出 Anki")).toBeInTheDocument();
    });
    expect(screen.queryByText(/导出成功/)).not.toBeInTheDocument();
    expect(screen.queryByText(/导出失败/)).not.toBeInTheDocument();
  });

  // ── 搜索态写操作后分级统计刷新（E4，改为局部更新 + getWordStats）──

  it("refreshes level stats after a write in search state without refetching the list", async () => {
    const { getWordsPage, getWordStats, deleteWord, getWords } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockImplementation(pageResponder(sampleWords));

    renderVocabularyPage();
    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    // 进入搜索态（防抖后服务端返回仅 ephemeral）
    const searchInput = screen.getByPlaceholderText(/搜索单词/);
    fireEvent.change(searchInput, { target: { value: "ephem" } });
    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByText(/共 1 个单词/)).toBeInTheDocument();
    });

    const pageCallsBefore = vi.mocked(getWordsPage).mock.calls.length;
    const statsCallsBefore = vi.mocked(getWordStats).mock.calls.length;

    // 删除搜索结果中的单词 → 局部移除 + getWordStats 刷新
    const deleteButtons = screen.getAllByRole("button").filter((btn) => {
      return btn.querySelector("svg") && btn.className.includes("h-8 w-8");
    });
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(deleteWord).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByText("ephemeral")).not.toBeInTheDocument();
    });
    expect(vi.mocked(getWordsPage).mock.calls.length).toBe(pageCallsBefore);
    expect(vi.mocked(getWordStats).mock.calls.length).toBeGreaterThan(statsCallsBefore);
    expect(getWords).not.toHaveBeenCalled();
  });

  // ── 单个补全空字段视为失败（E5）──

  it("treats an empty enrichment phonetic as a failed single enrichment", async () => {
    // resilience 缺失音标与释义（显示补全按钮）；LLM 返回空 phonetic 时
    // 不得写库（空串会覆盖原数据），并提示失败
    const { getWordsPage, updateWordEnrichment } = await import("@/lib/db");
    const { enrichWord } = await import("@/services/vocabulary-enrichment");
    vi.mocked(getWordsPage).mockResolvedValueOnce(pageOf(sampleWords));
    vi.mocked(enrichWord).mockResolvedValueOnce({
      phonetic: "   ",
      definition: "韧性，恢复力",
      collocations: "",
      example: "",
      level: null,
    });

    renderVocabularyPage();
    await waitFor(() => {
      expect(screen.getByText("resilience")).toBeInTheDocument();
    });

    // 补全按钮：ghost 小按钮，内含 h-3 图标（与词卡等级按钮区分）
    const enrichButtons = screen.getAllByRole("button").filter((btn) => {
      const svg = btn.querySelector("svg");
      return svg?.classList.contains("h-3") === true;
    });
    expect(enrichButtons).toHaveLength(1);
    fireEvent.click(enrichButtons[0]);

    await waitFor(() => {
      expect(screen.getByText(/"resilience" 补全失败/)).toBeInTheDocument();
    });
    expect(vi.mocked(updateWordEnrichment)).not.toHaveBeenCalled();
  });

  // ── 两个批次入口互斥（f15：并发跑同一取消令牌）──

  it("disables the batch enrich button while an import is running", async () => {
    // 并发入口必须关闭：两个批次共享同一 cancelledRef，并发跑会互相取消
    const { getWordsPage, addWordsBatch } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockResolvedValueOnce(pageOf(sampleWords)); // 挂载首页
    // 批量导入命令卡在第一条：导入批处理停在 running
    vi.mocked(addWordsBatch).mockReturnValue(new Promise(() => {}));

    renderVocabularyPage();
    await waitFor(() => {
      expect(screen.getByText("resilience")).toBeInTheDocument();
    });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [new File(["newword"], "words.csv", { type: "text/csv" })] },
      });
      // flush file.text() 微任务链，让导入进入 running
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });

    // 导入进入 running：按钮切为"导入中"，批量补全入口被禁用
    expect(screen.getByText(/导入中/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /批量补全/ })).toBeDisabled();
  });

  it("disables the import button while batch enrichment is running", async () => {
    const { getWordsPage } = await import("@/lib/db");
    const { enrichWord } = await import("@/services/vocabulary-enrichment");
    vi.mocked(getWordsPage).mockResolvedValue(pageOf(sampleWords));
    // 补全卡在第一条 enrichWord：批次停在 running
    vi.mocked(enrichWord).mockReturnValue(new Promise<null>(() => {}));

    renderVocabularyPage();
    await waitFor(() => {
      expect(screen.getByText("resilience")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /批量补全/ }));

    // 批次进入 running：补全按钮显示进度，导入入口被禁用
    await waitFor(() => {
      expect(screen.getByText(/补全中/)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /导入/ })).toBeDisabled();
  });

  // ── 手动添加走后端存在性预检（E2）──

  it("does not re-add a word the precheck finds in the notebook", async () => {
    // 搜索态/快照之外的已有词：预检命中即提示已存在，不发 addWord
    const { getWordsPage, getWords, addWord } = await import("@/lib/db");
    vi.mocked(getWordsPage).mockResolvedValueOnce(pageOf(sampleWords));
    // 预检窄查询返回词库中已有的 ubiquitous
    vi.mocked(getWords).mockResolvedValueOnce([sampleWords[1]]);

    renderVocabularyPage();
    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByText("手动添加")[0]);
    const wordInput = await screen.findByPlaceholderText(/输入英文单词/);
    fireEvent.change(wordInput, { target: { value: "ubiquitous" } });
    fireEvent.click(screen.getByRole("button", { name: /添加/ }));

    await waitFor(() => {
      expect(screen.getByText(/已存在于生词本中，未重复添加/)).toBeInTheDocument();
    });
    expect(vi.mocked(addWord)).not.toHaveBeenCalled();
  });

  // ── Navigation links ──

  it("renders 'start review' link to /review", async () => {
    renderVocabularyPage();

    const reviewLink = screen.getByText(/开始复习/).closest("a");
    expect(reviewLink).toHaveAttribute("href", "/review");
  });
});
