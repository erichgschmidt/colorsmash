import { describe, it, expect } from "vitest";
import { writeColorLookupLoadAtn } from "../atnWriter";

describe("atnWriter", () => {
  it("throws 'not implemented' until atn-format-research lands", () => {
    expect(() =>
      writeColorLookupLoadAtn({
        setName: "Color Smash",
        actionName: "Load Color Smash LUT",
        cubePath: "C:\\test\\path\\file.cube",
      }),
    ).toThrow(/not implemented/i);
  });

  // Golden-file byte-match test. The reference .atn is captured by recording
  // the equivalent action manually in PS, exporting via Actions panel → Save
  // Actions, and dropping the resulting bytes at:
  //
  //   plugin/src/core/__tests__/fixtures/color-smash-reference.atn
  //
  // That fixture does not exist yet — the import + assertion below are wired
  // up so flipping `it.skip` → `it` once the writer is implemented and the
  // fixture is in place gives us instant coverage.
  it.skip("byte-matches the golden Color Smash reference .atn", async () => {
    // Lazy require keeps the missing fixture from breaking module load.
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const goldenPath = path.join(__dirname, "fixtures", "color-smash-reference.atn");
    const goldenAtn = new Uint8Array(fs.readFileSync(goldenPath));

    const actual = writeColorLookupLoadAtn({
      setName: "Color Smash",
      actionName: "Load Color Smash LUT",
      cubePath: "C:\\test\\path\\file.cube",
    });

    expect(actual.length).toBe(goldenAtn.length);
    expect(Buffer.from(actual).equals(Buffer.from(goldenAtn))).toBe(true);
  });
});
