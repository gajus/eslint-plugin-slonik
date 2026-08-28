import type { RuleContext } from "./check-sql.rule";
import { shouldLintFile } from "./check-sql.utils";
import { describe, expect, it } from "vitest";

describe("shouldLintFile", () => {
  it.each(["ts", "tsx", "mts", "mtsx"])(
    "returns true for .%s files",
    (extension) => {
      expect(
        shouldLintFile({ filename: `file.${extension}` } as RuleContext),
      ).toBe(true);
    },
  );

  it.each(["js", "jsx", "mjs", "json"])(
    "returns false for .%s files",
    (extension) => {
      expect(
        shouldLintFile({ filename: `file.${extension}` } as RuleContext),
      ).toBe(false);
    },
  );
});
