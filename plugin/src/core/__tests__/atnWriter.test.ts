import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  writeColorLookupLoadAtn,
  writeTrimAtn,
  writeUnicodeString,
  writeOSType,
  writeTokenOrString,
  writePascalString,
  writeDescriptor,
} from "../atnWriter";

const fixture = (name: string) =>
  new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures", name)));

const hex = (b: Uint8Array): string =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join(" ");

describe("atnWriter primitives", () => {
  it("writeOSType pads short codes with 0x20 and rejects long ones", () => {
    expect(hex(writeOSType("Mk  "))).toBe("4d 6b 20 20");
    expect(hex(writeOSType("Mk"))).toBe("4d 6b 20 20");
    expect(hex(writeOSType("AdjL"))).toBe("41 64 6a 4c");
    expect(() => writeOSType("toolong")).toThrow();
  });

  it("writeUnicodeString matches the §3.1 'Trim' golden bytes", () => {
    // From research §3.1: 00 00 00 05 00 54 00 72 00 69 00 6D 00 00
    expect(hex(writeUnicodeString("Trim"))).toBe(
      "00 00 00 05 00 54 00 72 00 69 00 6d 00 00",
    );
    // Empty string => length 1 + a single NUL code unit
    expect(hex(writeUnicodeString(""))).toBe("00 00 00 01 00 00");
  });

  it("writePascalString omits any terminator (§3.2 'trim' example)", () => {
    expect(hex(writePascalString("trim"))).toBe("00 00 00 04 74 72 69 6d");
  });

  it("writeTokenOrString picks OSType form for 4-char ASCII, else length form", () => {
    expect(hex(writeTokenOrString("null"))).toBe("00 00 00 00 6e 75 6c 6c");
    expect(hex(writeTokenOrString("trimBasedOn"))).toBe(
      "00 00 00 0b 74 72 69 6d 42 61 73 65 64 4f 6e",
    );
  });

  it("writeDescriptor wraps classID1+classID2+itemCount around items", () => {
    // Empty descriptor for 'Trim' / 'trim': classID1 UnicodeString + classID2
    // (4-char ASCII => OSType form via writeTokenOrString) + itemCount=0
    const got = writeDescriptor("Trim", "trim", []);
    expect(hex(got)).toBe(
      "00 00 00 05 00 54 00 72 00 69 00 6d 00 00" + // "Trim\0"
        " 00 00 00 00 74 72 69 6d" + // OSType "trim"
        " 00 00 00 00", // itemCount = 0
    );
  });
});

describe("atnWriter — Trim.atn golden", () => {
  it("writeTrimAtn byte-matches mrijk/atn-parser Trim.atn", () => {
    const expected = fixture("trim-reference.atn");
    const actual = writeTrimAtn();
    if (actual.length !== expected.length || !Buffer.from(actual).equals(Buffer.from(expected))) {
      const dump = (b: Uint8Array) => hex(b.subarray(0, Math.min(b.length, 256)));
      throw new Error(
        `Trim.atn mismatch:\n  actual   (${actual.length} B): ${dump(actual)}\n` +
          `  expected (${expected.length} B): ${dump(expected)}`,
      );
    }
    expect(actual.length).toBe(expected.length);
    expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
  });
});

describe("writeColorLookupLoadAtn", () => {
  it("produces a plausible Uint8Array (sanity — full validation is loading in PS)", () => {
    const cubeBytes = new TextEncoder().encode("LUT_3D_SIZE 2\n0 0 0\n1 1 1\n");
    const out = writeColorLookupLoadAtn({
      setName: "Color Smash",
      actionName: "Load Color Smash LUT",
      cubePath: "C:\\test\\path\\file.cube",
      cubeBytes,
    });

    expect(out).toBeInstanceOf(Uint8Array);
    // Header: version 16
    expect(out[0]).toBe(0x00);
    expect(out[1]).toBe(0x00);
    expect(out[2]).toBe(0x00);
    expect(out[3]).toBe(0x10);
    // Reasonable size: header overhead + descriptor strings + cube bytes.
    expect(out.length).toBeGreaterThan(cubeBytes.length + 400);
    expect(out.length).toBeLessThan(8 * 1024);
  });
});
