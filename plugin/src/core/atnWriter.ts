// Photoshop .atn (Actions) binary writer.
//
// Implements the wire format documented in `docs/atn-format-research.md`
// (referenced as §N below). All multi-byte integers and UTF-16 strings are
// big-endian, no BOM, no padding. The writer is pure: it produces a
// `Uint8Array` from in-memory inputs and never touches the filesystem —
// `services/installAction.ts` is responsible for reading the .cube bytes and
// writing the resulting .atn into Photoshop's Presets/Actions folder.

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for {@link writeColorLookupLoadAtn}.
 *
 * SIGNATURE CHANGE (vs the original scaffold): the writer now also takes
 * `cubeBytes` so it stays pure and testable. Callers (see
 * `services/installAction.ts`) must read the .cube file via UXP and pass the
 * bytes alongside the path string. The path is still embedded in the
 * descriptor as `LUT3DFileName` because Photoshop displays it in the
 * Properties panel; the bytes are embedded as `LUT3DFileData`.
 */
export interface WriteColorLookupLoadAtnOptions {
  /** Name of the action *set* (top-level folder shown in PS Actions panel). */
  setName: string;
  /** Name of the single action inside the set. */
  actionName: string;
  /** Absolute filesystem path to the `.cube` LUT (embedded as TEXT). */
  cubePath: string;
  /** Raw bytes of the .cube file (embedded as `LUT3DFileData` tdta). */
  cubeBytes: Uint8Array;
}

/**
 * Produces the binary contents of a Photoshop `.atn` action-set file
 * containing one action with one `make` step that creates a Color Lookup
 * adjustment layer pre-loaded with the given .cube LUT (Shape A in
 * research §4.2 — embedded `LUT3DFileData`, no `profile`).
 */
export function writeColorLookupLoadAtn(opts: WriteColorLookupLoadAtnOptions & { targetLayerName?: string }): Uint8Array {
  const { setName, actionName, cubePath, cubeBytes, targetLayerName = "ColorSmashLUT_active" } = opts;

  // Matches what PS records when the user manually does Layer > New Adjustment Layer >
  // Color Lookup > Load 3D LUT: a `set` step targeting the active adjustmentLayer with a `to`
  // colorLookup descriptor. PS rejects the set form via batchPlay alone because there's no
  // active Color Lookup layer; the plugin's apply flow creates the empty layer first via
  // batchPlay so that targetEnum resolves correctly when the action plays.
  // Key needs TokenOrString form (length-zero sentinel + OSType), not bare OSType.
  // `Nm  ` is the canonical layer-name key Adobe uses.
  const nameItem = concat(
    tokOSType("Nm  "),
    osType("TEXT"),
    uniString(cubePath),
  );
  // classID1 = display name ("Color Lookup"), classID2 = internal ID ("colorLookup")
  // Adobe convention; verified via byte-diff against working .atn.
  const colorLookupDesc = writeDescriptorBody(
    "Color Lookup",
    tokString("colorLookup"),
    [
      itemEnum("lookupType", "colorLookupType", "3DLUT"),
      nameItem,
      itemText("LUT3DFileName", cubePath),
      itemTdta("LUT3DFileData", cubeBytes),
      itemEnum("LUTFormat", "LUTFormatType", "LUTFormatCUBE"),
    ],
  );

  // _target = obj ref with one Enmr (enum reference). PS emits classID1 as EMPTY
  // (length-1 just-NUL UnicodeString) when classID2 has a known 4-byte OSType — verified
  // via byte-diff against user's working .atn. Redundant full classID1 makes PS parse fail.
  const emptyClassID1 = u32(1); // length=1 UTF-16 unit (the NUL); content is implied 2 bytes 00 00
  const emptyTok = concat(emptyClassID1, u8(0), u8(0));
  const targetRef = concat(
    u32(1),
    osType("Enmr"),
    emptyTok, // classID1 empty
    tokOSType("AdjL"),
    tokOSType("Ordn"),
    tokOSType("Trgt"),
  );

  // Outer event: set / classID2 'setd', items = [null (target), T (to)].
  const setDescBody = writeDescriptorBody("set", tokOSType("setd"), [
    concat(tokOSType("null"), osType("obj "), targetRef),
    concat(tokOSType("T   "), osType("Objc"), colorLookupDesc),
  ]);

  void itemBool;

  // Event 1: Deselect Layers (matches user's working .atn structure).
  // Empty classID1 — see targetRef above.
  const deselectRef = concat(
    u32(1),
    osType("Enmr"),
    emptyTok,
    tokOSType("Lyr "),
    tokOSType("Ordn"),
    tokOSType("Trgt"),
  );
  const deselectDescBody = writeDescriptorBody("Deselect Layers", tokString("selectNoLayers"), [
    concat(tokOSType("null"), osType("obj "), deselectRef),
  ]);
  const deselectEvent = concat(
    u8(0), u8(1), u8(0), u8(0),
    ascii("TEXT"),
    pascalAscii("selectNoLayers"),
    pascalAscii("Deselect Layers"),
    i32(-1),
    deselectDescBody,
  );

  // Event 2: Select layer by exact name (a known temp name plugin renames the layer to).
  // Empty classID1 + OSType classID2.
  const selectRef = concat(
    u32(1),
    osType("name"), // name reference type
    emptyTok,
    tokOSType("Lyr "),
    uniString(targetLayerName),
  );
  const selectDescBody = writeDescriptorBody("select", tokOSType("slct"), [
    concat(tokOSType("null"), osType("obj "), selectRef),
    concat(tokOSType("MkVs"), osType("bool"), u8(0)),
  ]);
  const selectEvent = concat(
    u8(0), u8(1), u8(0), u8(0),
    ascii("TEXT"),
    pascalAscii("select"),
    pascalAscii("Select"),
    i32(-1),
    selectDescBody,
  );

  // Event 3: Set the LUT.
  const setEvent = concat(
    u8(0), u8(1), u8(0), u8(0),
    ascii("TEXT"),
    pascalAscii("set"),
    pascalAscii("Set"),
    i32(-1),
    setDescBody,
  );

  // Action: 3 events matching user's working .atn (Deselect → Select-by-name → Set).
  const action = concat(
    i16(0),
    u8(0),
    u8(0),
    i16(0),
    uniString(actionName),
    u8(0),
    u32(3),
    deselectEvent,
    selectEvent,
    setEvent,
  );

  // File header
  return concat(
    u32(0x00000010), // version = 16
    uniString(setName),
    u8(0), // setExpanded
    u32(1), // actionCount
    action,
  );
}

/**
 * Reproduces the exact `Trim.atn` bytes from mrijk/atn-parser (research §7).
 * This is the byte-equality golden used by the test suite to prove the
 * encoder matches the wire format.
 */
export function writeTrimAtn(): Uint8Array {
  // Note: classID2 in the golden file is the length-prefixed form
  // `00 00 00 04 "trim"`, NOT the 4-byte OSType form (the §7 annotation in
  // the research doc mis-labels this — verified against the actual hex at
  // offset 0x62 of the bundled Trim.atn).
  const trimDesc = writeDescriptorBody("Trim", tokString("trim"), [
    itemEnum("trimBasedOn", "trimBasedOn", "topLeftPixelColor"),
    concat(tokOSType("Top "), osType("bool"), u8(1)),
    concat(tokOSType("Btom"), osType("bool"), u8(1)),
    concat(tokOSType("Left"), osType("bool"), u8(1)),
    concat(tokOSType("Rght"), osType("bool"), u8(1)),
  ]);

  const event = concat(
    u8(1), // expanded
    u8(1), // enabled
    u8(0), // withDialog
    u8(0), // dialogOptions
    ascii("TEXT"),
    pascalAscii("trim"),
    pascalAscii("Trim"),
    i32(-1),
    trimDesc,
  );

  const action = concat(
    i16(0),
    u8(0),
    u8(0),
    i16(0),
    uniString("Action 1"),
    u8(1), // expanded
    u32(1),
    event,
  );

  return concat(u32(0x00000010), uniString("Trim"), u8(1), u32(1), action);
}

// ---------------------------------------------------------------------------
// Item helpers — return one descriptor item (key + type tag + payload).
// ---------------------------------------------------------------------------

function itemEnum(key: string, typeID: string, valueID: string): Uint8Array {
  return concat(tokString(key), osType("enum"), tokString(typeID), tokString(valueID));
}

function itemText(key: string, value: string): Uint8Array {
  return concat(tokString(key), osType("TEXT"), uniString(value));
}

function itemTdta(key: string, bytes: Uint8Array): Uint8Array {
  return concat(tokString(key), osType("tdta"), u32(bytes.length), bytes);
}

function itemBool(key: string, value: boolean): Uint8Array {
  return concat(tokString(key), osType("bool"), u8(value ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Descriptor body
// ---------------------------------------------------------------------------

/**
 * Body of a descriptor (classID1 UnicodeString + classID2 TokenOrString +
 * itemCount uint32 + concatenated items). Each `items[i]` must already be a
 * fully-formed item byte sequence (key + type + payload).
 */
function writeDescriptorBody(
  classID1: string,
  classID2: Uint8Array,
  items: Uint8Array[],
): Uint8Array {
  return concat(uniString(classID1), classID2, u32(items.length), ...items);
}

// ---------------------------------------------------------------------------
// Public primitive helpers (exposed surface declared in the task brief)
// ---------------------------------------------------------------------------

/** Write a big-endian uint32 into `buf` at `offset`. Returns new offset. */
export function writeUint32BE(buf: Uint8Array, offset: number, value: number): number {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
  return offset + 4;
}

/** 4-byte ASCII OSType, right-padded with 0x20 (§2.2 gotcha). */
export function writeOSType(value: string): Uint8Array {
  return osType(value);
}

/** PS UnicodeString: uint32 (UTF-16 units incl. NUL) + UTF-16BE bytes (§3.1). */
export function writeUnicodeString(s: string): Uint8Array {
  return uniString(s);
}

/** PS PascalString variant: uint32 byte length + raw ASCII (§3.2). */
export function writePascalString(s: string): Uint8Array {
  return pascalAscii(s);
}

/**
 * TokenOrString (§2.1): if `s` is exactly 4 ASCII chars emit form-1
 * (uint32(0) + 4-byte OSType), otherwise emit form-2 (uint32(N) + N raw
 * ASCII bytes). Note: this heuristic does NOT match every file in the wild
 * — `Trim.atn` uses the length form for `"trim"` even though it would fit
 * the OSType form. {@link writeTrimAtn} bypasses this helper for that
 * reason.
 */
export function writeTokenOrString(s: string): Uint8Array {
  if (s.length === 4 && isPureAscii(s)) {
    return tokOSType(s);
  }
  return tokString(s);
}

/** Public descriptor builder; classID2 is encoded via {@link writeTokenOrString}. */
export function writeDescriptor(
  classID1: string,
  classID2: string,
  items: Uint8Array[],
): Uint8Array {
  return writeDescriptorBody(classID1, writeTokenOrString(classID2), items);
}

/**
 * Wraps a descriptor body as an action step (event header + descriptor).
 * Convenience for callers building custom actions; the bundled
 * {@link writeColorLookupLoadAtn} inlines the equivalent for clarity.
 */
export function writeActionStep(opts: {
  expanded: boolean;
  enabled: boolean;
  withDialog: boolean;
  eventName: string; // e.g. "make"
  displayName: string; // e.g. "Make"
  descriptor: Uint8Array | null; // already-built descriptor body, or null
}): Uint8Array {
  return concat(
    u8(opts.expanded ? 1 : 0),
    u8(opts.enabled ? 1 : 0),
    u8(opts.withDialog ? 1 : 0),
    u8(0), // dialogOptions
    ascii("TEXT"),
    pascalAscii(opts.eventName),
    pascalAscii(opts.displayName),
    i32(opts.descriptor ? -1 : 0),
    ...(opts.descriptor ? [opts.descriptor] : []),
  );
}

// ---------------------------------------------------------------------------
// Internal byte primitives (each returns a fresh Uint8Array)
// ---------------------------------------------------------------------------

function u8(v: number): Uint8Array {
  return new Uint8Array([v & 0xff]);
}

function i16(v: number): Uint8Array {
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
}

function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  writeUint32BE(b, 0, v >>> 0);
  return b;
}

function i32(v: number): Uint8Array {
  return u32(v >>> 0);
}

function ascii(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) throw new Error(`ascii: non-ASCII char in ${JSON.stringify(s)}`);
    b[i] = c;
  }
  return b;
}

function isPureAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/** 4-byte ASCII right-padded with 0x20. */
function osType(code: string): Uint8Array {
  if (code.length > 4) throw new Error(`osType: '${code}' longer than 4 chars`);
  const padded = code.length === 4 ? code : code + " ".repeat(4 - code.length);
  return ascii(padded);
}

/** TokenOrString form-1: uint32(0) + 4-byte OSType. */
function tokOSType(code: string): Uint8Array {
  return concat(u32(0), osType(code));
}

/** TokenOrString form-2: uint32(N) + N raw ASCII bytes. */
function tokString(s: string): Uint8Array {
  const a = ascii(s);
  return concat(u32(a.length), a);
}

/**
 * TokenOrUnicodeString form-2 (§2.1): identical wire shape to
 * {@link uniString} (uint32 UTF-16-unit count incl. NUL + UTF-16BE).
 */
function tokUniString(s: string): Uint8Array {
  return uniString(s);
}
void tokUniString;

/** PS UnicodeString: uint32 length (UTF-16 units incl. NUL) + UTF-16BE. */
function uniString(s: string): Uint8Array {
  // BMP-only fast path: every JS code unit becomes one UTF-16BE code unit.
  // No BOM (§3, §8 gotcha #3). Trailing NUL is included in `length`
  // (§8 gotcha #4 — the off-by-one trap).
  const units = s.length + 1;
  const out = new Uint8Array(4 + units * 2);
  writeUint32BE(out, 0, units);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[4 + i * 2] = (c >> 8) & 0xff;
    out[4 + i * 2 + 1] = c & 0xff;
  }
  // trailing NUL is already zero-initialised
  return out;
}

/** uint32 byte length + raw ASCII bytes, no terminator (§3.2). */
function pascalAscii(s: string): Uint8Array {
  const a = ascii(s);
  return concat(u32(a.length), a);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
