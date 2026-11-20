/**
 * Reads a PowerDesigner XML PDM into an editing model while keeping the
 * original text and element offsets for lossless write-back.
 */
import type {
  PdmColumn,
  PdmDiagram,
  PdmIndex,
  PdmKey,
  PdmModel,
  PdmNamedObject,
  PdmRect,
  PdmReference,
  PdmReferenceSymbol,
  PdmTable,
  PdmTableSymbol,
} from './types';
import { childEl, childEls, parseXml, textOf, type XElement, type XmlDocument } from './xml';

export interface PdmDocument {
  xml: XmlDocument;
  /** Every object definition (element with an `Id` attribute) by its Id. */
  byId: Map<string, XElement>;
  model: PdmModel;
}

export class PdmFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdmFormatError';
  }
}

export function readPdm(source: string): PdmDocument {
  const head = source.slice(0, 512).replace(/^﻿/, '').trimStart();
  if (!head.startsWith('<?xml')) {
    throw new PdmFormatError('不是 XML 格式的 PDM 文件。二进制 PDM 请先在 PowerDesigner 中另存为 XML 格式。');
  }
  const enc = /encoding="([^"]+)"/.exec(head)?.[1];
  if (enc && enc.toUpperCase() !== 'UTF-8') {
    throw new PdmFormatError(`暂不支持 ${enc} 编码的 PDM 文件，仅支持 UTF-8。`);
  }

  const xml = parseXml(source);
  if (xml.piAttrs.signature !== 'PDM_DATA_MODEL_XML') {
    throw new PdmFormatError('文件不是 PowerDesigner 物理数据模型（PDM）。');
  }

  const byId = new Map<string, XElement>();
  indexIds(xml.root, byId);

  const modelEl = findFirst(xml.root, (el) => el.name === 'o:Model' && 'Id' in el.attrs);
  if (!modelEl) throw new PdmFormatError('PDM 文件中缺少 <o:Model> 元素。');

  const r = new Reader(xml);
  const defs = (name: string) => findAll(modelEl, (el) => el.name === name && 'Id' in el.attrs);

  const model: PdmModel = {
    ...r.named(modelEl),
    target: xml.piAttrs.Target ?? '',
    pdVersion: xml.piAttrs.version ?? '',
    maxIdNum: maxIdNum(byId),
    tables: defs('o:Table').map((el) => r.table(el)),
    references: defs('o:Reference').map((el) => r.reference(el)),
    diagrams: defs('o:PhysicalDiagram').map((el) => r.diagram(el)),
    views: defs('o:View').map((el) => r.named(el)),
    sequences: defs('o:Sequence').map((el) => r.named(el)),
    users: defs('o:User').map((el) => r.named(el)),
  };

  return { xml, byId, model };
}

class Reader {
  constructor(private readonly xml: XmlDocument) {}

  attr(el: XElement, name: string): string {
    const c = childEl(el, `a:${name}`);
    return c ? textOf(this.xml, c) : '';
  }

  num(el: XElement, name: string): number | null {
    const v = this.attr(el, name);
    return v === '' ? null : Number(v);
  }

  /** Ids referenced by `<c:{collection}><o:X Ref="..."/></c:...>`. */
  refs(el: XElement, collection: string): string[] {
    const c = childEl(el, `c:${collection}`);
    return c ? c.children.map((x) => x.attrs.Ref).filter((x): x is string => !!x) : [];
  }

  ref(el: XElement, collection: string): string | null {
    return this.refs(el, collection)[0] ?? null;
  }

  items(el: XElement, collection: string, name: string): XElement[] {
    const c = childEl(el, `c:${collection}`);
    return c ? childEls(c, name).filter((x) => 'Id' in x.attrs) : [];
  }

  named(el: XElement): PdmNamedObject {
    return {
      id: el.attrs.Id,
      objectId: this.attr(el, 'ObjectID'),
      name: this.attr(el, 'Name'),
      code: this.attr(el, 'Code'),
      comment: this.attr(el, 'Comment'),
    };
  }

  table(el: XElement): PdmTable {
    return {
      ...this.named(el),
      parentId: ownerOf(el),
      ownerId: this.ref(el, 'Owner'),
      columns: this.items(el, 'Columns', 'o:Column').map((c) => this.column(c)),
      keys: this.items(el, 'Keys', 'o:Key').map((k) => this.key(k)),
      primaryKeyId: this.ref(el, 'PrimaryKey'),
      indexes: this.items(el, 'Indexes', 'o:Index').map((x) => this.index(x)),
    };
  }

  column(el: XElement): PdmColumn {
    return {
      ...this.named(el),
      dataType: this.attr(el, 'DataType'),
      length: this.num(el, 'Length'),
      precision: this.num(el, 'Precision'),
      mandatory: this.attr(el, 'Column.Mandatory') === '1',
      defaultValue: this.attr(el, 'DefaultValue'),
      autoMigrated: this.attr(el, 'AutoMigrated') === '1',
    };
  }

  key(el: XElement): PdmKey {
    return { ...this.named(el), columnIds: this.refs(el, 'Key.Columns') };
  }

  index(el: XElement): PdmIndex {
    const columnIds = this.items(el, 'IndexColumns', 'o:IndexColumn')
      .map((ic) => this.ref(ic, 'Column'))
      .filter((x): x is string => !!x);
    return { ...this.named(el), unique: this.attr(el, 'Unique') === '1', columnIds };
  }

  reference(el: XElement): PdmReference {
    return {
      ...this.named(el),
      parentId: ownerOf(el),
      parentTableId: this.ref(el, 'ParentTable') ?? '',
      childTableId: this.ref(el, 'ChildTable') ?? '',
      parentKeyId: this.ref(el, 'ParentKey'),
      cardinality: this.attr(el, 'Cardinality'),
      joins: this.items(el, 'Joins', 'o:ReferenceJoin').map((j) => ({
        id: j.attrs.Id,
        objectId: this.attr(j, 'ObjectID'),
        parentColumnId: this.ref(j, 'Object1'),
        childColumnId: this.ref(j, 'Object2'),
      })),
    };
  }

  diagram(el: XElement): PdmDiagram {
    const symbols = childEl(el, 'c:Symbols')?.children.filter((s) => 'Id' in s.attrs) ?? [];
    const tableSymbols: PdmTableSymbol[] = [];
    const referenceSymbols: PdmReferenceSymbol[] = [];
    for (const s of symbols) {
      if (s.name === 'o:TableSymbol') {
        tableSymbols.push({
          id: s.attrs.Id,
          tableId: this.ref(s, 'Object') ?? '',
          rect: parseRect(this.attr(s, 'Rect')),
        });
      } else if (s.name === 'o:ReferenceSymbol') {
        referenceSymbols.push({
          id: s.attrs.Id,
          referenceId: this.ref(s, 'Object') ?? '',
          sourceSymbolId: this.ref(s, 'SourceSymbol'),
          destinationSymbolId: this.ref(s, 'DestinationSymbol'),
          rect: parseRect(this.attr(s, 'Rect')),
          points: parsePoints(this.attr(s, 'ListOfPoints')),
          orthogonal: this.attr(s, 'CornerStyle') === '2',
        });
      }
    }
    return { ...this.named(el), parentId: ownerOf(el), tableSymbols, referenceSymbols };
  }
}

/** Parses `((x1,y1), (x2,y2))`. */
export function parseRect(s: string): PdmRect | null {
  const p = parsePoints(s);
  if (p.length !== 2) return null;
  const [[ax, ay], [bx, by]] = p;
  return { x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by) };
}

/** Parses `((x,y),(x,y),...)`. */
export function parsePoints(s: string): Array<[number, number]> {
  return [...s.matchAll(/\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

/** Id of the object holding `el` in one of its collections (`<o:X><c:Y><el>`). */
function ownerOf(el: XElement): string {
  return el.parent?.parent?.attrs.Id ?? '';
}

/** Highest numeric part of the document's `oN` Ids. */
function maxIdNum(byId: Map<string, XElement>): number {
  let max = 0;
  for (const id of byId.keys()) {
    const n = /^o(\d+)$/.exec(id);
    if (n) max = Math.max(max, Number(n[1]));
  }
  return max;
}

function indexIds(el: XElement, out: Map<string, XElement>): void {
  const id = el.attrs.Id;
  if (id) out.set(id, el);
  for (const c of el.children) indexIds(c, out);
}

function findFirst(el: XElement, pred: (e: XElement) => boolean): XElement | undefined {
  if (pred(el)) return el;
  for (const c of el.children) {
    const hit = findFirst(c, pred);
    if (hit) return hit;
  }
  return undefined;
}

function findAll(el: XElement, pred: (e: XElement) => boolean, out: XElement[] = []): XElement[] {
  for (const c of el.children) {
    if (pred(c)) out.push(c);
    findAll(c, pred, out);
  }
  return out;
}
