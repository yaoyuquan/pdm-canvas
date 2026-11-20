/**
 * New models are created from blank templates saved by PowerDesigner
 * (`resources/templates/`), never generated from scratch (CLAUDE.md rule 1).
 * Instantiating a template only splices fresh identity into it: new GUIDs,
 * creation/modification time, and creator. Everything else stays byte-identical.
 */
import { applyEdits, type TextEdit } from './patch';
import { readPdm, PdmFormatError } from './reader';
import { encodeText, textOf, type XElement } from './xml';

/** Database types a new model can target; one blank template per kind. */
export type DbmsKind = 'oracle11g' | 'mysql50' | 'postgresql9';

/** One choice in the "新建模型" dialog. */
export interface DbmsOption {
  kind: DbmsKind;
  /** Display label; also the DBMS name PowerDesigner writes as `Target`. */
  label: string;
  /** Template file name under `resources/templates/`. */
  template: string;
}

/**
 * Supported targets, in dialog order (the first is the default). MySQL 5.0 and
 * PostgreSQL 9.x are the newest definitions PowerDesigner 16.7 ships.
 */
export const DBMS_OPTIONS: readonly DbmsOption[] = [
  { kind: 'oracle11g', label: 'ORACLE Version 11g', template: 'oracle11g.pdm' },
  { kind: 'mysql50', label: 'MySQL 5.0', template: 'mysql50.pdm' },
  { kind: 'postgresql9', label: 'PostgreSQL 9.x', template: 'postgresql9.pdm' },
];

/** Injected so tests can make the output deterministic. */
export interface InstantiateOptions {
  /** Written as `Creator`/`Modifier`, like PowerDesigner does with the OS user. */
  user: string;
  /** Creation time; stored as Unix seconds like PowerDesigner does. */
  now: Date;
  /** Returns a new random GUID (any case; written upper-case like PowerDesigner). */
  newGuid: () => string;
}

/**
 * Returns the text of a new model based on a blank PDM template.
 *
 * Without this, every model created from the same template would share the
 * same `ObjectID`s, and PowerDesigner treats equal GUIDs as the same object
 * (e.g. when comparing/merging models or using shortcuts between them).
 */
export function instantiateTemplate(source: string, opts: InstantiateOptions): string {
  const { xml, byId, model } = readPdm(source);
  const modelEl = byId.get(model.id);
  if (!modelEl) throw new PdmFormatError('模板中缺少模型对象。');

  // PowerDesigner stamps every object it creates with the same time, so the
  // model's creation date identifies which dates belong to the template.
  const templateStamp = textOf(xml, child(modelEl, 'a:CreationDate'));
  const stamp = String(Math.floor(opts.now.getTime() / 1000));
  const user = encodeText(opts.user);

  // Old GUID -> new GUID, so the header's copy of the model GUID can follow.
  const guids = new Map<string, string>();
  const edits: TextEdit[] = [];
  // Replaces only the element's text content, keeping its tags untouched.
  const replaceText = (el: XElement, text: string) => edits.push({ start: el.openEnd, end: el.closeStart, text });

  walk(xml.root, (el) => {
    // Empty elements such as `<a:GlobalObjectID/>` carry no value to replace.
    if (el.selfClosing) return;
    const value = textOf(xml, el);
    if (el.name === 'a:ObjectID') {
      // Only the template's own objects have an ObjectID. References to the
      // DBMS definition use TargetID/TargetModelID, which must stay fixed.
      const fresh = opts.newGuid().toUpperCase();
      guids.set(value, fresh);
      replaceText(el, fresh);
    } else if ((el.name === 'a:CreationDate' || el.name === 'a:ModificationDate') && value === templateStamp) {
      // Dates that differ from the template's own stamp (e.g. the DBMS
      // definition's TargetModel dates) describe other files; keep them.
      replaceText(el, stamp);
    } else if (el.name === 'a:Creator' || el.name === 'a:Modifier') {
      replaceText(el, user);
    }
  });

  // The `<?PowerDesigner ...?>` header repeats the model GUID and date. It sits
  // before the root element, so it never overlaps the edits collected above.
  const piStart = source.indexOf('<?PowerDesigner ');
  const piEnd = source.indexOf('?>', piStart);
  if (piStart < 0 || piEnd < 0) throw new PdmFormatError('模板缺少 PowerDesigner 文件头。');
  const pi = source
    .slice(piStart, piEnd)
    .replace(/ ID="\{([0-9A-Fa-f-]+)\}"/, (m, id: string) => (guids.has(id) ? ` ID="{${guids.get(id)}}"` : m))
    .replace(/ LastModificationDate="\d+"/, ` LastModificationDate="${stamp}"`);
  edits.push({ start: piStart, end: piEnd, text: pi });

  return applyEdits(source, edits);
}

/** Direct child element by name; the template is unusable without it. */
function child(el: XElement, name: string): XElement {
  const c = el.children.find((x) => x.name === name);
  if (!c) throw new PdmFormatError(`模板中缺少 <${name}>。`);
  return c;
}

/** Visits `el` and all its descendants in document order. */
function walk(el: XElement, fn: (el: XElement) => void): void {
  fn(el);
  for (const c of el.children) walk(c, fn);
}
