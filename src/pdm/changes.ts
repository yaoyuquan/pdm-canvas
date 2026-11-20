/**
 * Turns edits made to the editing model into text patches on the original
 * PDM source. Changes are computed as a diff between the model as last
 * loaded/saved and the current model, so undoing back to the original
 * state yields no changes at all.
 */
import { PdmPatchError } from './patch';
import { writeAttributeChanges } from './write';
import type { PdmDocument } from './reader';
import type { PdmColumn, PdmModel, PdmTable } from './types';

/** PDM attributes that can currently be edited. */
export type EditableAttr = 'Name' | 'Code' | 'Comment' | 'DataType' | 'DefaultValue' | 'Mandatory';

export const TABLE_ATTRS: readonly EditableAttr[] = ['Name', 'Code', 'Comment'];
export const COLUMN_ATTRS: readonly EditableAttr[] = [...TABLE_ATTRS, 'DefaultValue', 'DataType', 'Mandatory'];
export const EDITABLE_ATTRS = COLUMN_ATTRS;

/**
 * One attribute change. Values are strings as edited in the UI; `Mandatory`
 * uses `'1'` for mandatory and `''` for optional.
 */
export interface AttributeChange {
  /** PDM document-local `Id` of the edited object. */
  objectId: string;
  attr: EditableAttr;
  value: string;
}

/** Length and precision as PowerDesigner derives them from a data type such as `NUMBER(18,2)`. */
export function parseDataType(dataType: string): { length: number | null; precision: number | null } {
  const m = /\(\s*(\d+)\s*(?:(?:char|byte)\s*)?(?:,\s*(-?\d+)\s*)?\)/i.exec(dataType);
  if (!m) return { length: null, precision: null };
  return { length: Number(m[1]), precision: m[2] === undefined ? null : Number(m[2]) };
}

const isColumn = (obj: PdmTable | PdmColumn): obj is PdmColumn => 'dataType' in obj;

/** Reads an editable attribute from a table or column as a string. */
export function readAttr(obj: PdmTable | PdmColumn, attr: EditableAttr): string {
  switch (attr) {
    case 'Name':
      return obj.name;
    case 'Code':
      return obj.code;
    case 'Comment':
      return obj.comment;
  }
  if (!isColumn(obj)) throw new PdmPatchError(`${attr} is not a table attribute`);
  switch (attr) {
    case 'DataType':
      return obj.dataType;
    case 'DefaultValue':
      return obj.defaultValue;
    case 'Mandatory':
      return obj.mandatory ? '1' : '';
  }
}

/** Returns a copy of the object with one attribute changed. */
export function writeAttr<T extends PdmTable | PdmColumn>(obj: T, attr: EditableAttr, value: string): T {
  switch (attr) {
    case 'Name':
      return { ...obj, name: value };
    case 'Code':
      return { ...obj, code: value };
    case 'Comment':
      return { ...obj, comment: value };
  }
  if (!isColumn(obj)) throw new PdmPatchError(`${attr} is not a table attribute`);
  switch (attr) {
    case 'DataType':
      // Length and precision always follow the data type, as in PowerDesigner.
      return { ...obj, dataType: value, ...parseDataType(value) };
    case 'DefaultValue':
      return { ...obj, defaultValue: value };
    case 'Mandatory':
      return { ...obj, mandatory: value === '1' };
  }
}

export function diffAttributes(base: PdmModel, current: PdmModel): AttributeChange[] {
  const out: AttributeChange[] = [];
  const compare = (before: PdmTable | PdmColumn, after: PdmTable | PdmColumn, attrs: readonly EditableAttr[]) => {
    for (const attr of attrs) {
      const value = readAttr(after, attr);
      if (readAttr(before, attr) !== value) out.push({ objectId: after.id, attr, value });
    }
  };
  const baseTables = new Map(base.tables.map((t) => [t.id, t]));
  for (const t of current.tables) {
    const b = baseTables.get(t.id);
    if (!b) continue;
    compare(b, t, TABLE_ATTRS);
    const baseColumns = new Map(b.columns.map((c) => [c.id, c]));
    for (const c of t.columns) {
      const bc = baseColumns.get(c.id);
      if (bc) compare(bc, c, COLUMN_ATTRS);
    }
  }
  return out;
}

/**
 * Applies attribute changes to the document's original text and returns the
 * new text. Uses the same patch-tree writer as structural changes.
 */
export function writeChanges(doc: PdmDocument, changes: AttributeChange[]): string {
  for (const ch of changes) {
    if (!EDITABLE_ATTRS.includes(ch.attr)) throw new PdmPatchError(`Attribute ${ch.attr} cannot be edited`);
  }
  return writeAttributeChanges(doc, changes);
}
