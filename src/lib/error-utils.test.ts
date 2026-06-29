/**
 * Tests for getErrorMessage — verifies correct extraction from Tauri
 * AppError plain objects, native Error instances, strings, and edge cases.
 */

import { describe, expect, it } from "vitest";
import { getErrorMessage } from "./error-utils";

describe("getErrorMessage", () => {
  // ── Tauri v2 AppError (plain object with category + message) ──

  it("extracts message from Tauri AppError plain object", () => {
    const err = { category: "database", message: "Database error: no such column" };
    expect(getErrorMessage(err)).toBe("Database error: no such column");
  });

  it("extracts message from Tauri Credential error", () => {
    const err = { category: "credential", message: "Credential error: keyring set error: denied" };
    expect(getErrorMessage(err)).toBe("Credential error: keyring set error: denied");
  });

  it("extracts message from Tauri Export error", () => {
    const err = { category: "export", message: "Export error: CSV failed" };
    expect(getErrorMessage(err)).toBe("Export error: CSV failed");
  });

  // ── Native Error instances ──

  it("extracts message from native Error", () => {
    expect(getErrorMessage(new Error("something broke"))).toBe("something broke");
  });

  it("extracts message from TypeError", () => {
    expect(getErrorMessage(new TypeError("not a function"))).toBe("not a function");
  });

  // ── String errors ──

  it("returns string errors as-is", () => {
    expect(getErrorMessage("network timeout")).toBe("network timeout");
  });

  // ── Edge cases ──

  it("returns fallback for null", () => {
    expect(getErrorMessage(null)).toBe("未知错误");
  });

  it("returns fallback for undefined", () => {
    expect(getErrorMessage(undefined)).toBe("未知错误");
  });

  it("returns custom fallback when provided", () => {
    expect(getErrorMessage(null, "操作失败")).toBe("操作失败");
  });

  it("returns fallback for plain object without message", () => {
    expect(getErrorMessage({ foo: "bar" })).toBe("未知错误");
  });

  it("returns fallback for empty object", () => {
    expect(getErrorMessage({})).toBe("未知错误");
  });

  it("extracts from object with .error field", () => {
    const err = { error: "Something went wrong" };
    expect(getErrorMessage(err)).toBe("Something went wrong");
  });

  it("prefers .message over .error when both exist", () => {
    const err = { message: "primary", error: "secondary" };
    expect(getErrorMessage(err)).toBe("primary");
  });

  it("handles Tauri AppError with extra fields", () => {
    // Some error objects may carry extra metadata
    const err = { category: "io", message: "IO error: file missing", code: "ENOENT" };
    expect(getErrorMessage(err)).toBe("IO error: file missing");
  });

  it("calls custom toString on non-Error objects when no message/error", () => {
    const err = {
      code: 500,
      toString() {
        return "HTTP 500";
      },
    };
    expect(getErrorMessage(err)).toBe("HTTP 500");
  });
});
