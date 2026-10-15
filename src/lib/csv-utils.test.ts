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

describe("parseCsvLine quoted-field trimming (RFC 4180)", () => {
  it("preserves whitespace inside quoted fields", () => {
    // 引号内的前后空白是数据的一部分，旧实现对所有字段 trim 会破坏该语义
    expect(parseCsvLine('"  hello  ",world')).toEqual(["  hello  ", "world"]);
    expect(parseCsvLine('a,"  hello  "')).toEqual(["a", "  hello  "]);
  });

  it("still trims unquoted fields when quoted fields are present", () => {
    expect(parseCsvLine('  a  ,"  b  ", c ')).toEqual(["a", "  b  ", "c"]);
  });

  it("keeps newlines inside quoted fields without splitting or trimming", () => {
    expect(parseCsvLine('"  a\nb  ",c')).toEqual(["  a\nb  ", "c"]);
  });

  it("keeps commas and escaped quotes inside quoted fields unchanged", () => {
    expect(parseCsvLine('"  a, b  ","  c ""d"" e  "')).toEqual(["  a, b  ", '  c "d" e  ']);
  });

  it("tab branch still trims (that branch requires no quotes in the line)", () => {
    expect(parseCsvLine("  a  \t b ")).toEqual(["a", "b"]);
  });
});

describe("parseCsvLine tab detection (P2 regression)", () => {
  it("quoted field containing a tab is not mis-split by tab branch", () => {
    // 释义字段(引号内)含 Tab:原实现整行按 Tab 分割导致字段错位
    const line = 'word,"释义包含	制表符",extra';
    expect(parseCsvLine(line)).toEqual(["word", "释义包含\t制表符", "extra"]);
  });

  it("pure tab-separated line without quotes still splits by tab", () => {
    expect(parseCsvLine("word\tdefinition\tnote")).toEqual(["word", "definition", "note"]);
  });

  it("comma line with fewer tabs than commas uses comma parsing", () => {
    expect(parseCsvLine("a,b\tc,d")).toEqual(["a", "b\tc", "d"]);
  });
});
