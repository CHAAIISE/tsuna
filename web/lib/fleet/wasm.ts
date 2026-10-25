/**
 * Minimal reader of the parts of a contract Wasm the fleet page shows: exported function names
 * and the `contractmetav0` custom section (`ScMetaEntry` XDR stream of key/value strings).
 */

interface Section {
  id: number;
  name?: string;
  body: Uint8Array;
}

function leb128(bytes: Uint8Array, start: number): [value: number, next: number] {
  let value = 0;
  let shift = 0;
  let offset = start;
  for (;;) {
    const byte = bytes[offset++];
    if (byte === undefined) throw new Error("Truncated Wasm");
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, offset];
    shift += 7;
  }
}

const decoder = new TextDecoder();

function sections(wasm: Uint8Array): Section[] {
  const out: Section[] = [];
  let offset = 8; // magic + version
  while (offset < wasm.length) {
    const id = wasm[offset++] ?? 0;
    const [size, bodyStart] = leb128(wasm, offset);
    const end = bodyStart + size;
    if (id === 0) {
      const [nameLength, nameStart] = leb128(wasm, bodyStart);
      const name = decoder.decode(wasm.subarray(nameStart, nameStart + nameLength));
      out.push({ id, name, body: wasm.subarray(nameStart + nameLength, end) });
    } else {
      out.push({ id, body: wasm.subarray(bodyStart, end) });
    }
    offset = end;
  }
  return out;
}

/** Names of the exported functions (Wasm export kind 0). */
export function exportedFunctions(wasm: Uint8Array): string[] {
  const exports = sections(wasm).find(section => section.id === 7);
  if (!exports) return [];
  const { body } = exports;
  const names: string[] = [];
  let [count, offset] = leb128(body, 0);
  for (; count > 0; count--) {
    const [length, nameStart] = leb128(body, offset);
    const name = decoder.decode(body.subarray(nameStart, nameStart + length));
    const kind = body[nameStart + length];
    [, offset] = leb128(body, nameStart + length + 1);
    if (kind === 0) names.push(name);
  }
  return names;
}

/** `contractmetav0` entries: XDR `ScMetaEntry` (union tag 0, then key and value strings). */
export function contractMeta(wasm: Uint8Array): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const section of sections(wasm)) {
    if (section.name !== "contractmetav0") continue;
    const view = new DataView(section.body.buffer, section.body.byteOffset, section.body.byteLength);
    let offset = 0;
    const string = () => {
      const length = view.getUint32(offset);
      const value = decoder.decode(section.body.subarray(offset + 4, offset + 4 + length));
      offset += 4 + Math.ceil(length / 4) * 4;
      return value;
    };
    while (offset + 4 <= view.byteLength) {
      if (view.getUint32(offset) !== 0) break;
      offset += 4;
      const key = string();
      meta[key] = string();
    }
  }
  return meta;
}
