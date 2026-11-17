/**
 * Turns edits made to the editing model into text patches on the original
 * PDM source. Changes are computed as a diff between the model as last
 * loaded/saved and the current model, so undoing back to the original
 * state yields no changes at all.
 */
import { applyEdits, PdmPatchError, setAttribute } from './patch';
import type { PdmDocument } from './reader';
import type { PdmModel, PdmNamedObject } from './types';

/** PDM attributes that can currently be edited. */
export type EditableAttr = 'Name' | 'Code' | 'Comment';

export const EDITABLE_ATTRS: readonly EditableAttr[] = ['Name', 'Code', 'Comment'];

/** Model field backing each editable attribute. */
export const ATTR_FIELD = { Name: 'name', Code: 'code', Comment: 'comment' } as const satisfies Record<
  EditableAttr,
  keyof PdmNamedObject
>;

export interface AttributeChange {
  /** PDM document-local `Id` of the edited object. */
  objectId: string;
  attr: EditableAttr;
  value: string;
}

/** Object kinds whose attributes may be patched. */
const PATCHABLE = new Set(['o:Table', 'o:Column']);

export function diffAttributes(base: PdmModel, current: PdmModel): AttributeChange[] {
  const out: AttributeChange[] = [];
  const compare = (before: PdmNamedObject, after: PdmNamedObject) => {
    for (const attr of EDITABLE_ATTRS) {
      const field = ATTR_FIELD[attr];
      if (before[field] !== after[field]) out.push({ objectId: after.id, attr, value: after[field] });
    }
  };
  const baseTables = new Map(base.tables.map((t) => [t.id, t]));
  for (const t of current.tables) {
    const b = baseTables.get(t.id);
    if (!b) continue;
    compare(b, t);
    const baseColumns = new Map(b.columns.map((c) => [c.id, c]));
    for (const c of t.columns) {
      const bc = baseColumns.get(c.id);
      if (bc) compare(bc, c);
    }
  }
  return out;
}

/** Applies attribute changes to the document's original text and returns the new text. */
export function writeChanges(doc: PdmDocument, changes: AttributeChange[]): string {
  const edits = changes.flatMap((ch) => {
    const el = doc.byId.get(ch.objectId);
    if (!el || !PATCHABLE.has(el.name)) throw new PdmPatchError(`Object ${ch.objectId} cannot be edited`);
    if (!EDITABLE_ATTRS.includes(ch.attr)) throw new PdmPatchError(`Attribute ${ch.attr} cannot be edited`);
    if ((ch.attr === 'Name' || ch.attr === 'Code') && ch.value.trim() === '') {
      throw new PdmPatchError(`${ch.attr} of ${ch.objectId} must not be empty`);
    }
    return setAttribute(doc, ch.objectId, ch.attr, ch.value);
  });
  return applyEdits(doc.xml.source, edits);
}
