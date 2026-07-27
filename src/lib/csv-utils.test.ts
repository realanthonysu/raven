import { describe, expect, it } from "vitest";
import { parseCsvLine } from "./csv-utils";

describe("parseCsvLine", () => {
  it("splits simple comma-separated fields", () => {
    expect(parseCsvLine("hello,world,foo")).toEqual(["hello", "world", "foo"]);
  });

  it("trims whitespace from fields", () => {
    expect(parseCsvLine("  hello , world  , foo ")).toEqual(["hello", "world", "foo"]);
  });

  it("handles single field", () => {
    expect(parseCsvLine("hello")).toEqual(["hello"]);
  });

  it("handles empty string", () => {
    expect(parseCsvLine("")).toEqual([""]);
  });

  it("handles quoted fields with commas", () => {
    expect(parseCsvLine('"hello, world",foo')).toEqual(["hello, world", "foo"]);
  });

  it("handles escaped quotes inside quoted fields", () => {
    expect(parseCsvLine('"She said ""hi""",bar')).toEqual(['She said "hi"', "bar"]);
  });

  it("handles tab-separated fields", () => {
    expect(parseCsvLine("hello\tworld\tfoo")).toEqual(["hello", "world", "foo"]);
  });

  it("handles tab-separated fields with trimming", () => {
    expect(parseCsvLine("  hello \t world \t foo ")).toEqual(["hello", "world", "foo"]);
  });

  it("handles mixed quoted and unquoted fields", () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(["a", "b,c", "d"]);
  });

  it("handles empty fields", () => {
    expect(parseCsvLine("a,,c")).toEqual(["a", "", "c"]);
  });

  it("handles quoted empty string", () => {
    expect(parseCsvLine('"",a')).toEqual(["", "a"]);
  });

  it("handles field ending with quote", () => {
    expect(parseCsvLine('"hello",world')).toEqual(["hello", "world"]);
  });
});
