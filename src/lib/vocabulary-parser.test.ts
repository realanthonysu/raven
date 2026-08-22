import { describe, expect, it } from "vitest";
import { parseVocabularyEntries } from "./vocabulary-parser";

describe("parseVocabularyEntries", () => {
  it("解析标准格式：粗体单词 + 音标 + 标签字段", () => {
    const md = [
      "**ephemeral** /ɪˈfemərəl/",
      "释义：短暂的，转瞬即逝的",
      "常见搭配：ephemeral beauty",
      "例句：Fame is ephemeral.",
    ].join("\n");

    expect(parseVocabularyEntries(md)).toEqual([
      {
        word: "ephemeral",
        phonetic: "ɪˈfemərəl",
        definition: "短暂的，转瞬即逝的",
        collocations: "ephemeral beauty",
        example: "Fame is ephemeral.",
      },
    ]);
  });

  it("音标在下一行时仍能识别新词条", () => {
    const md = ["**ubiquitous**", "/juːˈbɪkwɪtəs/", "释义：无处不在的"].join("\n");

    const entries = parseVocabularyEntries(md);
    expect(entries).toHaveLength(1);
    expect(entries[0].word).toBe("ubiquitous");
    expect(entries[0].phonetic).toBe("juːˈbɪkwɪtəs");
    expect(entries[0].definition).toBe("无处不在的");
  });

  it("过滤中文小标题（搭配/例句等）不误识别为词汇", () => {
    const md = [
      "**hello** /həˈloʊ/",
      "释义：你好",
      "**搭配**：common greeting",
      "**例句**：Hello, world.",
    ].join("\n");

    const entries = parseVocabularyEntries(md);
    expect(entries).toHaveLength(1);
    expect(entries[0].word).toBe("hello");
    // 粗体小标题行不作为词条，归入上一个 group（标签+粗体不匹配字段正则，字段为空）
    expect(entries[0].collocations).toBe("");
    expect(entries[0].example).toBe("");
  });

  it("非粗体小标题行归入上一个词条并正常提取字段", () => {
    const md = [
      "**hello** /həˈloʊ/",
      "释义：你好",
      "常见搭配：common greeting",
      "例句：Hello, world.",
    ].join("\n");

    const entries = parseVocabularyEntries(md);
    expect(entries).toHaveLength(1);
    expect(entries[0].collocations).toBe("common greeting");
    expect(entries[0].example).toBe("Hello, world.");
  });

  it("多个词条按顺序解析", () => {
    const md = ["**apple** /ˈæpl/", "释义：苹果", "**banana** /bəˈnænə/", "释义：香蕉"].join("\n");

    const entries = parseVocabularyEntries(md);
    expect(entries.map((e) => e.word)).toEqual(["apple", "banana"]);
    expect(entries[1].definition).toBe("香蕉");
  });

  it("同一单词多次出现时去重并合并非空字段", () => {
    const md = ["**run** /rʌn/", "释义：跑", "**Run**", "/rʌn/", "例句：I run every day."].join(
      "\n",
    );

    const entries = parseVocabularyEntries(md);
    expect(entries).toHaveLength(1);
    expect(entries[0].definition).toBe("跑");
    expect(entries[0].example).toBe("I run every day.");
  });

  it("无标签释义且无音标时，提取斜杠包裹的中文作为释义", () => {
    const md = ["**grace**", "/优雅/", "其他内容"].join("\n");

    const entries = parseVocabularyEntries(md);
    expect(entries).toHaveLength(1);
    expect(entries[0].definition).toBe("优雅");
  });

  it("无音标行时降级提取音标行后的第一个中文行作为释义", () => {
    const md = ["**serene**", "/səˈriːn/", "宁静的", "- 补充说明"].join("\n");

    const entries = parseVocabularyEntries(md);
    expect(entries).toHaveLength(1);
    expect(entries[0].phonetic).toBe("səˈriːn");
    expect(entries[0].definition).toBe("宁静的");
  });

  it("非词汇内容（无粗体标记或无音标佐证）返回空数组", () => {
    expect(parseVocabularyEntries("普通文本，没有任何词汇。")).toEqual([]);
    expect(parseVocabularyEntries("**只是一个加粗短语**\n后面没有音标。")).toEqual([]);
    expect(parseVocabularyEntries("")).toEqual([]);
  });

  it("过长的粗体内容（≥50 字符）不视为词汇", () => {
    const longWord = "a".repeat(50);
    const md = `**${longWord}** /æ/\n释义：x`;
    expect(parseVocabularyEntries(md)).toEqual([]);
  });
});
