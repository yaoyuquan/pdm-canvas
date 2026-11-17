/**
 * Write-back for PDM documents: edits are expressed as text splices on the
 * original source, so everything not explicitly edited stays byte-identical.
 */
import type { PdmDocument } from './reader';
import { childEl, encodeText, type XElement } from './xml';

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * Attribute elements a new `<a:X>` is inserted after, in preference order.
 * Mirrors the order PowerDesigner writes standard object attributes.
 */
const ATTR_ANCHORS = [
  'a:Comment',
  'a:Modifier',
  'a:ModificationDate',
  'a:Creator',
  'a:CreationDate',
  'a:Code',
  'a:Name',
  'a:ObjectID',
];

export class PdmPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdmPatchError';
  }
}

/**
 * Sets (or removes, when `value` is empty) a simple text attribute such as
 * `Comment` on the object with the given PDM `Id`.
 */
export function setAttribute(doc: PdmDocument, objectId: string, attr: string, value: string): TextEdit[] {
  const el = doc.byId.get(objectId);
  if (!el) throw new PdmPatchError(`Object ${objectId} not found`);
  const { eol } = doc.xml;
  const tag = `a:${attr}`;
  const encoded = encodeText(value.replace(/\r?\n/g, eol));
  const existing = childEl(el, tag);

  if (existing) {
    if (value === '') {
      // Remove the element together with the line break preceding it.
      const prev = doc.xml.source.lastIndexOf(eol, existing.start);
      const start = prev >= el.openEnd ? prev : existing.start;
      return [{ start, end: existing.end, text: '' }];
    }
    if (existing.selfClosing) {
      return [{ start: existing.start, end: existing.end, text: `<${tag}>${encoded}</${tag}>` }];
    }
    return [{ start: existing.openEnd, end: existing.closeStart, text: encoded }];
  }

  if (value === '') return [];
  const anchor = findAnchor(el, tag);
  const at = anchor ? anchor.end : el.openEnd;
  return [{ start: at, end: at, text: `${eol}<${tag}>${encoded}</${tag}>` }];
}

function findAnchor(el: XElement, tag: string): XElement | undefined {
  const start = ATTR_ANCHORS.indexOf(tag);
  const candidates = start >= 0 ? ATTR_ANCHORS.slice(start + 1) : ATTR_ANCHORS;
  for (const name of candidates) {
    const hit = childEl(el, name);
    if (hit) return hit;
  }
  return undefined;
}

/** Applies non-overlapping edits to the source and returns the new text. */
export function applyEdits(source: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw new PdmPatchError(`Overlapping edits at offsets ${sorted[i - 1].start} and ${sorted[i].start}`);
    }
  }
  let out = '';
  let pos = 0;
  for (const e of sorted) {
    out += source.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + source.slice(pos);
}
