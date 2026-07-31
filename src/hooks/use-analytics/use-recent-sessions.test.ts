/**
 * useRecentSessions hook tests.
 *
 * 覆盖 15 条截取、按时间降序、文本预览截断和各类型的分数/类别分派。
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HistoryRecord } from "@/types";
import type { ParsedExercise } from "./use-exercise-analytics";
import type { ParsedListening } from "./use-listening-analytics";
import { useRecentSessions } from "./use-recent-sessions";
import type { ParsedSpeaking } from "./use-speaking-analytics";
import type { ParsedCorrection } from "./use-writing-analytics";

function makeRecord(
  id: number,
  type: HistoryRecord["type"],
  createdAt: string,
  inputText = `text-${id}`,
): HistoryRecord {
  return {
    id,
    type,
    input_text: inputText,
    result: "",
    graph_data: null,
    created_at: createdAt,
  };
}

describe("useRecentSessions", () => {
  it("returns at most 15 sessions sorted newest first", () => {
    const records = Array.from({ length: 20 }, (_, i) =>
      makeRecord(i + 1, "reading", `2026-07-${String(i + 1).padStart(2, "0")}T10:00:00`),
    );

    const { result } = renderHook(() => useRecentSessions(records, [], [], [], []));

    expect(result.current.recentSessions).toHaveLength(15);
    expect(result.current.recentSessions[0].id).toBe(20);
    expect(result.current.recentSessions[14].id).toBe(6);
  });

  it("truncates long input text to 60 chars with ellipsis", () => {
    const longText = "a".repeat(80);
    const records = [makeRecord(1, "reading", "2026-07-01T10:00:00", longText)];

    const { result } = renderHook(() => useRecentSessions(records, [], [], [], []));

    expect(result.current.recentSessions[0].textPreview).toBe(`${"a".repeat(60)}...`);
  });

  it("dispatches type-specific details from pre-parsed results", () => {
    const correctRecord = makeRecord(1, "correct", "2026-07-04T10:00:00");
    const exerciseRecord = makeRecord(2, "exercise", "2026-07-03T10:00:00");
    const listeningRecord = makeRecord(3, "listening", "2026-07-02T10:00:00");
    const speakingRecord = makeRecord(4, "speaking", "2026-07-01T10:00:00");

    const parsed: ParsedCorrection[] = [
      {
        record: correctRecord,
        result: {
          corrected_text: "c",
          corrections: [
            { original: "o", corrected: "f", category: "时态错误", explanation: "e" },
            { original: "o2", corrected: "f2", category: "时态错误", explanation: "e" },
            { original: "o3", corrected: "f3", category: "拼写错误", explanation: "e" },
          ],
          summary: "s",
        },
      },
    ];
    const parsedExercises: ParsedExercise[] = [
      {
        record: exerciseRecord,
        result: {
          category: "时态错误",
          exercises: [
            { type: "fill", question: "q", answer: "a", explanation: "e" },
            { type: "fill", question: "q2", answer: "a", explanation: "e" },
          ],
          userAnswers: ["a", "a"],
          score: 1,
        },
      },
    ];
    const parsedListening: ParsedListening[] = [
      {
        record: listeningRecord,
        result: {
          difficulty: "中级",
          topic: "日常对话",
          sentences: [
            { text: "s1", hint: "h" },
            { text: "s2", hint: "h" },
            { text: "s3", hint: "h" },
          ],
          userInputs: ["", "", ""],
          score: 2,
        },
      },
    ];
    const parsedSpeaking: ParsedSpeaking[] = [
      {
        record: speakingRecord,
        result: {
          difficulty: "中级",
          topic: "日常对话",
          sentences: [{ text: "s", translation: "t" }],
          results: [],
          averageScore: 85,
        },
      },
    ];

    const { result } = renderHook(() =>
      useRecentSessions(
        [correctRecord, exerciseRecord, listeningRecord, speakingRecord],
        parsed,
        parsedExercises,
        parsedListening,
        parsedSpeaking,
      ),
    );

    const [correct, exercise, listening, speaking] = result.current.recentSessions;
    // correct：出现最多的类别 + 错误总数
    expect(correct.topCategory).toBe("时态错误");
    expect(correct.total).toBe(3);
    // exercise：得分/总题数
    expect(exercise.score).toBe(1);
    expect(exercise.total).toBe(2);
    // listening：得分/总句数
    expect(listening.score).toBe(2);
    expect(listening.total).toBe(3);
    // speaking：平均分/总句数
    expect(speaking.score).toBe(85);
    expect(speaking.total).toBe(1);
  });

  it("leaves score fields undefined when no parsed result matches", () => {
    const records = [makeRecord(1, "exercise", "2026-07-01T10:00:00")];

    const { result } = renderHook(() => useRecentSessions(records, [], [], [], []));

    expect(result.current.recentSessions[0].score).toBeUndefined();
    expect(result.current.recentSessions[0].total).toBeUndefined();
  });
});
