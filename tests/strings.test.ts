import { describe, expect, it } from "vitest";
import { firstNonEmpty } from "../src/util/strings.js";

describe("firstNonEmpty", () => {
  it("mengembalikan nilai non-kosong pertama", () => {
    expect(firstNonEmpty(undefined, "", "openai", "anthropic")).toBe("openai");
  });

  it("melewati string kosong (beda dari ??)", () => {
    // `"" ?? x` mengembalikan "", sedangkan firstNonEmpty melewatinya.
    expect(firstNonEmpty("", "custom:9router")).toBe("custom:9router");
  });

  it("mengembalikan undefined bila semua kosong", () => {
    expect(firstNonEmpty(undefined, "", "")).toBeUndefined();
  });
});
