import { describe, expect, it } from "vitest";
import { ENRICHMENT_PROMPT } from "./enrichment";

describe("ENRICHMENT_PROMPT", () => {
  it("interpolates the target word", () => {
    const prompt = ENRICHMENT_PROMPT("serendipity");
    expect(prompt).toContain("单词：serendipity");
  });

  it("requests strict JSON output with all four EnrichedWord fields", () => {
    const prompt = ENRICHMENT_PROMPT("word");
    expect(prompt).toContain("JSON 格式");
    expect(prompt).toContain('"phonetic"');
    expect(prompt).toContain('"definition"');
    expect(prompt).toContain('"collocations"');
    expect(prompt).toContain('"example"');
  });
});
