/**
 * use-batch-runner 运行骨架测试。
 *
 * 覆盖进度回传、完成/失败汇总、getKey 去重透传、取消中止、finally 复位
 * 与 reset 手动复位（file.text()/getWords() 等错误路径）。
 */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type BatchSummary, useBatchRunner } from "./use-batch-runner";

function setup() {
  return renderHook(() => useBatchRunner());
}

describe("useBatchRunner", () => {
  it("keeps running/progress during the batch and resets after completion", async () => {
    const { result } = setup();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder: { promise?: Promise<BatchSummary>; summary?: BatchSummary } = {};

    await act(async () => {
      holder.promise = result.current.run(["a", "b"], {
        isCancelled: () => false,
        processItem: async (item) => {
          if (item === "a") await gate;
          return true;
        },
      });
      // 第一条挂起在 gate 上：running 已置位、进度停在 0/2
      await Promise.resolve();
    });

    expect(result.current.running).toBe(true);
    expect(result.current.progress).toEqual({ current: 0, total: 2 });

    await act(async () => {
      release();
      holder.summary = await holder.promise;
    });

    expect(holder.summary).toEqual({ completed: 2, failed: 0 });
    expect(result.current.running).toBe(false);
    expect(result.current.progress).toEqual({ current: 0, total: 0 });
  });

  it("counts false returns and thrown errors as failures without stopping", async () => {
    const { result } = setup();
    const processed: string[] = [];
    const holder: { summary?: BatchSummary } = {};

    await act(async () => {
      holder.summary = await result.current.run(["a", "b", "c"], {
        isCancelled: () => false,
        processItem: async (item) => {
          processed.push(item);
          if (item === "b") return false;
          if (item === "c") throw new Error("boom");
          return true;
        },
      });
    });

    expect(processed).toEqual(["a", "b", "c"]);
    expect(holder.summary).toEqual({ completed: 1, failed: 2 });
    expect(result.current.running).toBe(false);
    expect(result.current.progress).toEqual({ current: 0, total: 0 });
  });

  it("passes getKey through so duplicate keys are skipped", async () => {
    const { result } = setup();
    const processed: string[] = [];
    const holder: { summary?: BatchSummary } = {};

    await act(async () => {
      holder.summary = await result.current.run(["a", "a", "b"], {
        isCancelled: () => false,
        getKey: (item) => item,
        processItem: async (item) => {
          processed.push(item);
          return true;
        },
      });
    });

    expect(processed).toEqual(["a", "b"]);
    expect(holder.summary).toEqual({ completed: 2, failed: 0 });
  });

  it("stops at the next item once isCancelled flips true", async () => {
    const { result } = setup();
    const processed: string[] = [];
    const holder: { summary?: BatchSummary } = {};
    let cancel = false;

    await act(async () => {
      holder.summary = await result.current.run(["a", "b", "c"], {
        isCancelled: () => cancel,
        processItem: async (item) => {
          processed.push(item);
          if (item === "a") cancel = true;
          return true;
        },
      });
    });

    expect(processed).toEqual(["a"]);
    expect(holder.summary).toEqual({ completed: 1, failed: 0 });
    expect(result.current.running).toBe(false);
    expect(result.current.progress).toEqual({ current: 0, total: 0 });
  });

  it("reset() clears running and progress outside a run (error paths)", async () => {
    const { result } = setup();

    await act(async () => {
      // 永不 resolve：批次保持 running，等待调用方走错误路径复位
      void result.current.run(["a"], {
        isCancelled: () => false,
        processItem: () => new Promise<boolean>(() => {}),
      });
      await Promise.resolve();
    });

    expect(result.current.running).toBe(true);
    expect(result.current.progress).toEqual({ current: 0, total: 1 });

    await act(async () => {
      result.current.reset();
    });

    expect(result.current.running).toBe(false);
    expect(result.current.progress).toEqual({ current: 0, total: 0 });
  });
});
