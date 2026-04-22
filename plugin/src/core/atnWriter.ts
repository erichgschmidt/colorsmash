// Photoshop .atn (Actions) binary writer.
//
// SCAFFOLD ONLY — actual binary serialization is pending the parallel
// `atn-format-research` task. Once the format is documented, the helpers below
// (`writeUint32BE`, `writeOSType`, `writeUnicodeString`, `writeDescriptor`,
// `writeActionStep`) get fleshed out and `writeColorLookupLoadAtn` composes them
// into the final byte stream.

/**
 * Options for {@link writeColorLookupLoadAtn}.
 */
export interface WriteColorLookupLoadAtnOptions {
  /** Name of the action *set* (the top-level folder shown in PS Actions panel). */
  setName: string;
  /** Name of the single action inside the set. */
  actionName: string;
  /**
   * Absolute filesystem path to the `.cube` LUT the recorded action will load
   * via Color Lookup → 3DLUT File. Path is embedded into the action's
   * descriptor as a Unicode string (PS reads it back at play time).
   */
  cubePath: string;
}

/**
 * Produces the binary contents of a Photoshop `.atn` action-set file.
 *
 * The returned bytes describe a one-action set:
 *
 *   - Set named `opts.setName`
 *     - Action named `opts.actionName`
 *       - Step 1: `make` a `Color Lookup` adjustment layer
 *       - Step 2: `set` its `profile`/`lookupType` to `file` and load the
 *         3D LUT from `opts.cubePath` (the equivalent of the user clicking
 *         3DLUT File → Load 3D LUT in the Properties panel)
 *
 * Writing this file to `Adobe Photoshop <version>/Presets/Actions/` and
 * reloading PS (or Actions panel → Load Actions) registers the action so it
 * can be invoked via {@link applyLutViaAction} without the user ever recording
 * the Color Lookup load step manually — which is the whole point: PS does not
 * expose a scriptable path to that file picker, but a pre-recorded action
 * replays it just fine.
 *
 * The on-disk format is Adobe's documented Action Manager binary layout:
 * big-endian, version header, set descriptor, recursive event/descriptor
 * tree with OSType-tagged values. See `docs/atn-format.md` (pending) for the
 * field-by-field layout this writer targets.
 *
 * @throws Error — currently unconditionally; implementation pending
 * `atn-format-research`.
 */
export function writeColorLookupLoadAtn(opts: WriteColorLookupLoadAtnOptions): Uint8Array {
  void opts;
  throw new Error("not implemented — pending atn-format-research");
}

// ---------------------------------------------------------------------------
// Internal helper stubs. Signatures locked in so the writer body can be
// drafted against them; bodies fill in once the format is nailed down.
// ---------------------------------------------------------------------------

/** Append a big-endian uint32 to `out` at `offset`. Returns new offset. */
function writeUint32BE(_out: Uint8Array, _offset: number, _value: number): number {
  throw new Error("not implemented — pending atn-format-research");
}

/**
 * Append a 4-char OSType code (e.g. `"Mk  "`, `"Lyr "`, `"null"`).
 * Pads/truncates to exactly 4 ASCII bytes.
 */
function writeOSType(_out: Uint8Array, _offset: number, _code: string): number {
  throw new Error("not implemented — pending atn-format-research");
}

/**
 * Append a PS-style Unicode string: uint32 length (in UTF-16 code units,
 * including the trailing NUL) followed by big-endian UTF-16 code units.
 */
function writeUnicodeString(_out: Uint8Array, _offset: number, _value: string): number {
  throw new Error("not implemented — pending atn-format-research");
}

/**
 * Append an Action Manager descriptor: class id, item count, then each
 * key/typed-value pair. The shape of `descriptor` will be refined to a
 * proper discriminated union once the format research lands.
 */
function writeDescriptor(_out: Uint8Array, _offset: number, _descriptor: unknown): number {
  throw new Error("not implemented — pending atn-format-research");
}

/**
 * Append a single recorded step inside an action: event id (e.g. `"Mk  "`),
 * dialog-options byte, optional descriptor payload.
 */
function writeActionStep(_out: Uint8Array, _offset: number, _step: unknown): number {
  throw new Error("not implemented — pending atn-format-research");
}

// Suppress unused-warnings for the stubs until the writer body uses them.
void writeUint32BE;
void writeOSType;
void writeUnicodeString;
void writeDescriptor;
void writeActionStep;
