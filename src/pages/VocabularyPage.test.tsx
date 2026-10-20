/**
 * VocabularyPage component-level tests.
 *
 * Mocks db functions (getWords, deleteWord, updateWordLevel, etc.),
 * SpeakButton, and LLM enrichment service. 导出走 Rust 侧
 * writeTextFileDialog（原生保存对话框），不再经过前端 dialog 插件。
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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 删除二次确认：jsdom 的 confirm 默认返回 false 会拦截删除操作
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
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
    const { getWords } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);

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
    const { getWords } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);

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
    // 分级掌握度：CET-6 1 词（ephemeral, learning）；TEM-4 1 词（ubiquitous, new）；
    // 未标记 1 词（resilience, new）。统计复用挂载时的全量加载，不额外发 IPC。
    const { getWords } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("分级掌握度")).toBeInTheDocument();
    });

    expect(screen.getByText(/1 词 · 新0 学1 掌0/)).toBeInTheDocument();
    expect(screen.getAllByText(/1 词 · 新1 学0 掌0/)).toHaveLength(2);
    expect(screen.getByText("未标记")).toBeInTheDocument();
  });

  it("renders notes when available", async () => {
    const { getWords } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText(/ephemeral beauty/)).toBeInTheDocument();
    });
  });

  // ── Delete word ──

  it("can delete a word", async () => {
    const { getWords, deleteWord } = await import("@/lib/db");
    vi.mocked(getWords)
      .mockResolvedValueOnce(sampleWords)
      .mockResolvedValueOnce(sampleWords.filter((w) => w.id !== 1));
    vi.mocked(deleteWord).mockResolvedValue(undefined);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

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
  });

  // ── Search / filter ──

  it("filters words by search input", async () => {
    const { getWords } = await import("@/lib/db");
    // B2: 搜索下推服务端——mock 按 search 关键字过滤(持久实现,
    // 挂载时初始加载与防抖搜索共用;Once 会被防抖请求消耗掉)
    vi.mocked(getWords).mockImplementation((_l?: number, _o?: number, search?: string) => {
      const kw = search?.toLowerCase() ?? "";
      return Promise.resolve(sampleWords.filter((w) => !kw || w.word.toLowerCase().includes(kw)));
    });

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/搜索单词/);
    fireEvent.change(searchInput, { target: { value: "ephem" } });

    await waitFor(() => {
      expect(getWords).toHaveBeenCalledWith(undefined, undefined, "ephem");
    });
    // 服务端返回过滤后的结果(仅 ephemeral 匹配)
    await waitFor(() => {
      expect(screen.queryByText("ubiquitous")).not.toBeInTheDocument();
      expect(screen.queryByText("resilience")).not.toBeInTheDocument();
      expect(screen.getByText(/共 1 个单词/)).toBeInTheDocument();
    });
  });

  it("filters words by level", async () => {
    const { getWords } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    // Click the TEM-4 filter button (in the filter bar, not the per-word level buttons)
    const filterButtons = screen.getAllByRole("button", { name: "TEM-4" });
    fireEvent.click(filterButtons[0]);

    // Only ubiquitous (TEM-4) should be visible in the filtered list
    expect(screen.queryByText("ephemeral")).not.toBeInTheDocument();
    expect(screen.getByText("ubiquitous")).toBeInTheDocument();
    expect(screen.getByText(/共 1 个单词/)).toBeInTheDocument();
  });

  it("clears level filter when clicking the same level again", async () => {
    const { getWords } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    // Apply CET-6 filter
    const cet6Buttons = screen.getAllByRole("button", { name: "CET-6" });
    fireEvent.click(cet6Buttons[0]);

    expect(screen.getByText(/共 1 个单词/)).toBeInTheDocument();

    // Click CET-6 again to clear filter
    fireEvent.click(cet6Buttons[0]);

    expect(screen.getByText(/共 3 个单词/)).toBeInTheDocument();
  });

  it("loads the word list exactly once on mount (no duplicate full-table IPC)", async () => {
    // 回归：挂载 effect 与 search 防抖 effect（search="" 时）曾各发一次相同的
    // db_get_words 全表 IPC。合并为单一 effect 后，推进过防抖窗口仍应只有一次。
    const { getWords } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValue(sampleWords);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve();
    });

    expect(getWords).toHaveBeenCalledTimes(1);
    expect(getWords).toHaveBeenCalledWith(undefined, undefined, undefined);
  });

  it("clears a word's level when clicking its current level again", async () => {
    // 注释与行为对齐：点击单词当前已选中的等级 → 传空串清空等级
    // （Rust 侧 update_word_level 支持空串清空）
    const { getWords, updateWordLevel } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValue(sampleWords);
    vi.mocked(updateWordLevel).mockResolvedValue(undefined);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    // 区分顶部筛选按钮（size sm，无 h-6）与词卡片上的等级按钮（h-6）；
    // 词卡片按 words 顺序渲染，第一个即 ephemeral（已标记 CET-6）
    const wordLevelCet6Buttons = screen
      .getAllByRole("button", { name: "CET-6" })
      .filter((btn) => btn.className.includes("h-6"));
    fireEvent.click(wordLevelCet6Buttons[0]);

    await waitFor(() => {
      expect(updateWordLevel).toHaveBeenCalledWith(1, "");
    });
  });

  it("shows no-match message when search has no results", async () => {
    const { getWords } = await import("@/lib/db");
    vi.mocked(getWords).mockImplementation((_l?: number, _o?: number, search?: string) => {
      const kw = search?.toLowerCase() ?? "";
      return Promise.resolve(sampleWords.filter((w) => !kw || w.word.toLowerCase().includes(kw)));
    });

    renderVocabularyPage();

    await waitFor(() => {
      expect(getWords).toHaveBeenCalled();
    });
    // 等待初始数据渲染
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
    const { getWords } = await import("@/lib/db");
    vi.mocked(getWords).mockRejectedValueOnce(new Error("数据库连接失败"));

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
    const { getLocalDate, getWords, writeTextFileDialog } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);

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
    const { getWords, writeTextFileDialog } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);

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
    const { getWords, writeTextFileDialog } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);
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

  // ── 搜索态写操作后分级统计刷新（E4）──

  it("refreshes the level stats with a full fetch after a write in search state", async () => {
    // 搜索态下主列表只是结果子集：删除后必须另拉一次全量更新统计快照，
    // 否则分级掌握度停留在删除前的计数
    const { getWords, deleteWord } = await import("@/lib/db");
    vi.mocked(getWords).mockImplementation((_l?: number, _o?: number, search?: string) => {
      const kw = search?.toLowerCase() ?? "";
      return Promise.resolve(sampleWords.filter((w) => !kw || w.word.toLowerCase().includes(kw)));
    });

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

    const callsBefore = vi
      .mocked(getWords)
      .mock.calls.filter((args) => args[2] === undefined).length;

    // 删除搜索结果中的单词 → refresh() 触发全量统计刷新
    const deleteButtons = screen.getAllByRole("button").filter((btn) => {
      return btn.querySelector("svg") && btn.className.includes("h-8 w-8");
    });
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(deleteWord).toHaveBeenCalled();
    });
    await waitFor(() => {
      const fullFetches = vi
        .mocked(getWords)
        .mock.calls.filter((args) => args[2] === undefined).length;
      expect(fullFetches).toBeGreaterThan(callsBefore);
    });
  });

  // ── 单个补全空字段视为失败（E5）──

  it("treats an empty enrichment phonetic as a failed single enrichment", async () => {
    // resilience 缺失音标与释义（显示补全按钮）；LLM 返回空 phonetic 时
    // 不得写库（空串会覆盖原数据），并提示失败
    const { getWords, updateWordEnrichment } = await import("@/lib/db");
    const { enrichWord } = await import("@/services/vocabulary-enrichment");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);
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
    const { getWords, addWord } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords); // 挂载全量加载
    // 去重基线取模块级默认（空词库）；导入批处理卡在第一条 addWord
    vi.mocked(addWord).mockReturnValue(new Promise<number>(() => {}));

    renderVocabularyPage();
    await waitFor(() => {
      expect(screen.getByText("resilience")).toBeInTheDocument();
    });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [new File(["newword"], "words.csv", { type: "text/csv" })] },
      });
      // flush file.text() / getWords() 微任务链，让导入进入 running
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });

    // 导入进入 running：按钮切为"导入中"，批量补全入口被禁用
    expect(screen.getByText(/导入中/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /批量补全/ })).toBeDisabled();
  });

  it("disables the import button while batch enrichment is running", async () => {
    const { getWords } = await import("@/lib/db");
    const { enrichWord } = await import("@/services/vocabulary-enrichment");
    vi.mocked(getWords).mockResolvedValue(sampleWords);
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
    const { getWords, addWord } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);
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
