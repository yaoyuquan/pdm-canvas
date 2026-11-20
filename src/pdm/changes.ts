/**
 * Turns edits made to the editing model into text patches on the original
 * PDM source. Changes are computed as a diff between the model as last
 * loaded/saved and the current model, so undoing back to the original
 * state yields no changes at all.
 */
import { applyEdits, ATTR_ORDER, PdmPatchError, setAttribute } from './patch';
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

/** Element kinds each attribute may be written to. */
function allowedOn(attr: EditableAttr): ReadonlySet<string> {
  return TABLE_ATTRS.includes(attr) ? new Set(['o:Table', 'o:Column']) : new Set(['o:Column']);
}

/** One `<a:X>` element to set or (when `value` is empty) remove. */
interface ElementChange {
  objectId: string;
  attr: string;
  value: string;
}

/** Expands an attribute change into the PDM elements it touches. */
function toElements(ch: AttributeChange): ElementChange[] {
  const { objectId, value } = ch;
  switch (ch.attr) {
    case 'DataType': {
      const { length, precision } = parseDataType(value);
      return [
        { objectId, attr: 'DataType', value },
        { objectId, attr: 'Length', value: length === null ? '' : String(length) },
        { objectId, attr: 'Precision', value: precision === null ? '' : String(precision) },
      ];
    }
    case 'Mandatory':
      return [{ objectId, attr: 'Column.Mandatory', value: value === '1' ? '1' : '' }];
    default:
      return [{ objectId, attr: ch.attr, value }];
  }
}

const orderOf = (attr: string) => ATTR_ORDER.indexOf(`a:${attr}`);

/** Applies attribute changes to the document's original text and returns the new text. */
export function writeChanges(doc: PdmDocument, changes: AttributeChange[]): string {
  const elements = changes.flatMap((ch) => {
    const el = doc.byId.get(ch.objectId);
    if (!EDITABLE_ATTRS.includes(ch.attr)) throw new PdmPatchError(`Attribute ${ch.attr} cannot be edited`);
    if (!el || !allowedOn(ch.attr).has(el.name)) {
      throw new PdmPatchError(`Attribute ${ch.attr} of object ${ch.objectId} cannot be edited`);
    }
    if ((ch.attr === 'Name' || ch.attr === 'Code' || ch.attr === 'DataType') && ch.value.trim() === '') {
      throw new PdmPatchError(`${ch.attr} of ${ch.objectId} must not be empty`);
    }
    return toElements(ch);
  });
  // Several new elements may be inserted at the same offset; emitting them in
  // PowerDesigner's order keeps them in that order (edits are sorted stably).
  elements.sort((a, b) => orderOf(a.attr) - orderOf(b.attr));
  const edits = elements.flatMap((e) => setAttribute(doc, e.objectId, e.attr, e.value));
  return applyEdits(doc.xml.source, edits);
}
