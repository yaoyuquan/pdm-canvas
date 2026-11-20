/**
 * Save path for all model edits: attribute changes and structural changes
 * (tables, columns, keys, references, diagram symbols).
 *
 * The editing model is compared with the model as last loaded/saved
 * (`diffModel`), and only the differences are applied to the original text
 * through the patch tree (`tree.ts`). New objects are written in exactly the
 * element order and style PowerDesigner 16.7.5 uses for them (checked against
 * files PowerDesigner itself saved).
 */
import { ATTR_ORDER } from './patch';
import type { PdmDocument } from './reader';
import { PatchTree, PdmTreeError, type PNode } from './tree';
import type {
  PdmColumn,
  PdmDiagram,
  PdmKey,
  PdmModel,
  PdmRect,
  PdmReference,
  PdmReferenceSymbol,
  PdmTable,
  PdmTableSymbol,
} from './types';
import { encodeText } from './xml';
import { diffAttributes, parseDataType, type AttributeChange } from './changes';

/** One difference between the saved model and the edited model. */
export type ModelChange =
  | ({ type: 'attr' } & AttributeChange)
  | { type: 'addTable'; tableId: string }
  | { type: 'deleteTable'; tableId: string }
  /** Columns of an existing table were added, deleted, or reordered. */
  | { type: 'columns'; tableId: string }
  /** Keys or the primary key of an existing table changed. */
  | { type: 'keys'; tableId: string }
  | { type: 'addReference'; referenceId: string }
  | { type: 'deleteReference'; referenceId: string }
  /** Symbols were added to or removed from an existing diagram. */
  | { type: 'symbols'; diagramId: string }
  /** An existing symbol was moved (its rectangle or link points changed). */
  | { type: 'geometry'; symbolId: string };

/** Who and when, written into new objects like PowerDesigner does. */
export interface WriteContext {
  user: string;
  now: Date;
}

/**
 * Model collections in PowerDesigner's order (from PD 16.7.5 output). New
 * collections are inserted after the nearest existing predecessor.
 */
const CONTAINER_COLLECTIONS = [
  'c:DBMS',
  'c:PhysicalDiagrams',
  'c:Packages',
  'c:DefaultDiagram',
  'c:Users',
  'c:Tables',
  'c:Views',
  'c:References',
  'c:Sequences',
  'c:DefaultGroups',
  'c:TargetModels',
];

/** Table collections in PowerDesigner's order. */
const TABLE_COLLECTIONS = ['c:Columns', 'c:Keys', 'c:Indexes', 'c:Owner', 'c:Triggers', 'c:PrimaryKey'];

/** Key collections in PowerDesigner's order. */
const KEY_COLLECTIONS = ['c:ExtendedCollections', 'c:Key.Columns'];

/** Diagram collections: symbols come after all diagram attributes. */
const DIAGRAM_COLLECTIONS = ['c:Symbols'];

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** Lists what changed between `base` (as saved) and `current` (as edited). */
export function diffModel(base: PdmModel, current: PdmModel): ModelChange[] {
  const out: ModelChange[] = diffAttributes(base, current).map((a) => ({ type: 'attr' as const, ...a }));

  const baseTables = new Map(base.tables.map((t) => [t.id, t]));
  const currentTables = new Map(current.tables.map((t) => [t.id, t]));
  for (const t of current.tables) {
    const b = baseTables.get(t.id);
    if (!b) {
      out.push({ type: 'addTable', tableId: t.id });
      continue;
    }
    if (
      !sameList(
        b.columns.map((c) => c.id),
        t.columns.map((c) => c.id),
      )
    ) {
      out.push({ type: 'columns', tableId: t.id });
    }
    if (keySignature(b) !== keySignature(t)) out.push({ type: 'keys', tableId: t.id });
  }
  for (const b of base.tables) {
    if (!currentTables.has(b.id)) out.push({ type: 'deleteTable', tableId: b.id });
  }

  const baseRefs = new Set(base.references.map((r) => r.id));
  for (const r of current.references) {
    if (!baseRefs.has(r.id)) out.push({ type: 'addReference', referenceId: r.id });
  }
  const currentRefs = new Set(current.references.map((r) => r.id));
  for (const r of base.references) {
    if (!currentRefs.has(r.id)) out.push({ type: 'deleteReference', referenceId: r.id });
  }

  const baseDiagrams = new Map(base.diagrams.map((d) => [d.id, d]));
  for (const d of current.diagrams) {
    const b = baseDiagrams.get(d.id);
    if (!b) continue;
    if (!sameList(symbolIds(b), symbolIds(d))) out.push({ type: 'symbols', diagramId: d.id });
    out.push(...geometryChanges(b, d));
  }
  return out;
}

/** Symbols present in both versions of a diagram whose position changed. */
function geometryChanges(base: PdmDiagram, current: PdmDiagram): ModelChange[] {
  const out: ModelChange[] = [];
  const tables = new Map(base.tableSymbols.map((s) => [s.id, s]));
  for (const s of current.tableSymbols) {
    const b = tables.get(s.id);
    if (b && JSON.stringify(b.rect) !== JSON.stringify(s.rect)) out.push({ type: 'geometry', symbolId: s.id });
  }
  const refs = new Map(base.referenceSymbols.map((s) => [s.id, s]));
  for (const s of current.referenceSymbols) {
    const b = refs.get(s.id);
    if (b && JSON.stringify([b.rect, b.points]) !== JSON.stringify([s.rect, s.points])) {
      out.push({ type: 'geometry', symbolId: s.id });
    }
  }
  return out;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Keys, their columns, and the primary key, as one comparable string. */
function keySignature(t: PdmTable): string {
  return JSON.stringify([t.primaryKeyId, t.keys.map((k) => [k.id, k.columnIds])]);
}

function symbolIds(d: PdmDiagram): string[] {
  return [...d.tableSymbols.map((s) => s.id), ...d.referenceSymbols.map((s) => s.id)];
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Returns the document text with `current` written into it. Throws (and
 * writes nothing) when a change cannot be applied safely.
 */
export function writeModel(doc: PdmDocument, current: PdmModel, ctx: WriteContext): string {
  const w = new Writer(doc, ctx);
  w.apply(diffModel(doc.model, current), current);
  return w.tree.serialize();
}

/** Applies attribute changes only (kept for callers that edit attributes). */
export function writeAttributeChanges(doc: PdmDocument, changes: AttributeChange[]): string {
  const w = new Writer(doc, { user: '', now: new Date(0) });
  for (const ch of changes) w.attribute(ch);
  return w.tree.serialize();
}

class Writer {
  readonly tree: PatchTree;
  /** Ids of every object removed from the file, including nested ones. */
  private readonly deleted = new Set<string>();
  private readonly stamp: string;
  private readonly user: string;

  constructor(
    private readonly doc: PdmDocument,
    ctx: WriteContext,
  ) {
    this.tree = new PatchTree(doc.xml, doc.byId);
    this.stamp = String(Math.floor(ctx.now.getTime() / 1000));
    this.user = encodeText(ctx.user);
  }

  apply(changes: ModelChange[], current: PdmModel): void {
    const tables = new Map(current.tables.map((t) => [t.id, t]));
    const diagrams = new Map(current.diagrams.map((d) => [d.id, d]));
    const references = new Map(current.references.map((r) => [r.id, r]));
    const tableSymbols = new Map(current.diagrams.flatMap((d) => d.tableSymbols.map((x) => [x.id, x] as const)));
    const refSymbols = new Map(current.diagrams.flatMap((d) => d.referenceSymbols.map((x) => [x.id, x] as const)));

    // Deletions first, so later steps see the final set of objects.
    for (const ch of changes) {
      if (ch.type === 'deleteTable') this.removeObject(ch.tableId);
      else if (ch.type === 'deleteReference') this.removeObject(ch.referenceId);
    }
    // New tables and references, all at once per container: a collection
    // created for the first one cannot be edited again for the next.
    const newTables = changes.flatMap((ch) => (ch.type === 'addTable' ? [tables.get(ch.tableId)!] : []));
    const newRefs = changes.flatMap((ch) => (ch.type === 'addReference' ? [references.get(ch.referenceId)!] : []));
    this.addObjects('c:Tables', newTables, (t) => this.tableXml(t));
    this.addObjects('c:References', newRefs, (r) => this.referenceXml(r));
    for (const ch of changes) {
      switch (ch.type) {
        case 'attr':
          this.attribute(ch);
          break;
        case 'columns':
          this.columns(tables.get(ch.tableId)!);
          break;
        case 'keys':
          this.keys(tables.get(ch.tableId)!);
          break;
        case 'symbols':
          this.symbols(diagrams.get(ch.diagramId)!);
          break;
        case 'geometry': {
          const ts = tableSymbols.get(ch.symbolId);
          const rs = refSymbols.get(ch.symbolId);
          this.geometry(ch.symbolId, ts?.rect ?? rs?.rect ?? null, rs?.points);
          break;
        }
      }
    }
    // Last: drop references to anything that no longer exists.
    this.cleanUpReferences();
  }

  // ----- attributes -------------------------------------------------------

  /** Writes one attribute change of an existing table or column. */
  attribute(ch: AttributeChange): void {
    const node = this.tree.byId(ch.objectId);
    const el = this.doc.byId.get(ch.objectId);
    const allowed = ['Name', 'Code', 'Comment'].includes(ch.attr) ? ['o:Table', 'o:Column'] : ['o:Column'];
    if (!node || !el || !allowed.includes(el.name)) {
      throw new PdmTreeError(`Attribute ${ch.attr} of object ${ch.objectId} cannot be edited`);
    }
    if ((ch.attr === 'Name' || ch.attr === 'Code' || ch.attr === 'DataType') && ch.value.trim() === '') {
      throw new PdmTreeError(`${ch.attr} of ${ch.objectId} must not be empty`);
    }
    switch (ch.attr) {
      case 'DataType': {
        // Length and precision always follow the data type, as in PowerDesigner.
        const { length, precision } = parseDataType(ch.value);
        this.setAttr(node, 'DataType', ch.value);
        this.setAttr(node, 'Length', length === null ? '' : String(length));
        this.setAttr(node, 'Precision', precision === null ? '' : String(precision));
        break;
      }
      case 'Mandatory':
        this.setAttr(node, 'Column.Mandatory', ch.value === '1' ? '1' : '');
        break;
      default:
        this.setAttr(node, ch.attr, ch.value);
    }
  }

  /** Sets, inserts (in PowerDesigner's order), or removes (when empty) `<a:attr>`. */
  private setAttr(node: PNode, attr: string, value: string): void {
    const tag = `a:${attr}`;
    const existing = node.child(tag);
    if (value === '') {
      if (existing) node.remove(existing);
      return;
    }
    if (existing) existing.setText(value);
    else node.insertOrdered(this.tree.fragment([`<${tag}>${this.text(value)}</${tag}>`]), ATTR_ORDER);
  }

  // ----- tables -----------------------------------------------------------

  /**
   * Appends new objects (tables or references) to the collection `name` of
   * the model or package that holds each one, creating the collection in
   * PowerDesigner's position when the container has none yet.
   */
  private addObjects<T extends { parentId: string; code: string }>(
    name: string,
    objects: readonly T[],
    xmlOf: (o: T) => string[],
  ): void {
    const byContainer = new Map<string, T[]>();
    for (const o of objects) byContainer.set(o.parentId, [...(byContainer.get(o.parentId) ?? []), o]);
    for (const [parentId, group] of byContainer) {
      const container = this.tree.byId(parentId);
      if (!container) throw new PdmTreeError(`${group[0].code} 的所属模型或包 ${parentId} 不存在`);
      const coll = container.child(name);
      if (coll) for (const o of group) coll.insert(this.tree.fragment(xmlOf(o)));
      else {
        const xml = group.flatMap(xmlOf);
        container.insertOrdered(this.tree.fragment([`<${name}>`, ...xml, `</${name}>`]), CONTAINER_COLLECTIONS);
      }
    }
  }

  /** Rewrites the column list of an existing table: adds, deletes, reorders. */
  private columns(t: PdmTable): void {
    const table = this.object(t.id);
    const coll = table.child('c:Columns');
    const before = new Set((coll?.children() ?? []).map((c) => c.id));
    for (const id of before) {
      if (id && !t.columns.some((c) => c.id === id)) this.markDeleted(this.object(id));
    }
    const nodes = t.columns.map((c) => (before.has(c.id) ? this.object(c.id) : this.tree.fragment(this.columnXml(c))));
    if (coll) coll.setChildren(nodes);
    else if (nodes.length) {
      // A table without columns gets a new collection (all its columns are new).
      const xml = t.columns.flatMap((c) => this.columnXml(c));
      table.insertOrdered(this.tree.fragment(['<c:Columns>', ...xml, '</c:Columns>']), TABLE_COLLECTIONS);
    }
  }

  /** Rewrites keys and the primary key of an existing table. */
  private keys(t: PdmTable): void {
    const table = this.object(t.id);
    const coll = table.child('c:Keys');
    const before = new Set((coll?.children() ?? []).map((k) => k.id));
    for (const id of before) {
      if (id && !t.keys.some((k) => k.id === id)) this.markDeleted(this.object(id));
    }

    const nodes = t.keys.map((k) => {
      if (!before.has(k.id)) return this.tree.fragment(this.keyXml(k));
      const node = this.object(k.id);
      this.setRefs(node, 'c:Key.Columns', 'o:Column', k.columnIds, KEY_COLLECTIONS);
      return node;
    });
    if (coll) coll.setChildren(nodes);
    else if (nodes.length) {
      const xml = t.keys.flatMap((k) => this.keyXml(k));
      table.insertOrdered(this.tree.fragment(['<c:Keys>', ...xml, '</c:Keys>']), TABLE_COLLECTIONS);
    }

    this.setRefs(table, 'c:PrimaryKey', 'o:Key', t.primaryKeyId ? [t.primaryKeyId] : [], TABLE_COLLECTIONS);
  }

  /**
   * Makes the collection `name` under `node` hold exactly `ids` as
   * `<{kind} Ref=".."/>`, keeping existing ref nodes where they match.
   */
  private setRefs(node: PNode, name: string, kind: string, ids: string[], order: readonly string[]): void {
    const coll = node.child(name);
    const current = (coll?.children() ?? []).map((c) => c.ref);
    if (
      sameList(
        current.map((x) => x ?? ''),
        ids,
      )
    )
      return;
    if (coll) {
      // Reuse original ref elements so unchanged ones keep their exact bytes.
      const byRef = new Map(coll.children().map((c) => [c.ref, c]));
      coll.setChildren(ids.map((id) => byRef.get(id) ?? this.tree.fragment([`<${kind} Ref="${id}"/>`])));
    } else if (ids.length) {
      node.insertOrdered(
        this.tree.fragment([`<${name}>`, ...ids.map((id) => `<${kind} Ref="${id}"/>`), `</${name}>`]),
        order,
      );
    }
  }

  // ----- diagram symbols --------------------------------------------------

  /**
   * Adds new symbols and removes deleted ones in an existing diagram. As in
   * PowerDesigner's files, reference links come before table symbols: new
   * links go after the last existing link, new tables at the end.
   */
  private symbols(d: PdmDiagram): void {
    const diagram = this.object(d.id);
    const wanted = new Set([...d.tableSymbols.map((s) => s.id), ...d.referenceSymbols.map((s) => s.id)]);
    const coll = diagram.child('c:Symbols');
    const existing = new Set<string>();
    for (const s of coll?.children() ?? []) {
      if (!s.id) continue;
      existing.add(s.id);
      if (!wanted.has(s.id)) {
        coll!.remove(s);
        this.markDeleted(s);
      }
    }
    const links = d.referenceSymbols.filter((s) => !existing.has(s.id)).map((s) => this.referenceSymbolXml(s));
    const tables = d.tableSymbols.filter((s) => !existing.has(s.id)).map((s) => this.tableSymbolXml(s));
    if (links.length === 0 && tables.length === 0) return;
    if (coll) {
      let at = 0;
      coll.children().forEach((c, i) => {
        if (c.name === 'o:ReferenceSymbol') at = i + 1;
      });
      for (const xml of links) coll.insert(this.tree.fragment(xml), at++);
      for (const xml of tables) coll.insert(this.tree.fragment(xml));
    } else {
      const xml = [...links, ...tables].flat();
      diagram.insertOrdered(this.tree.fragment(['<c:Symbols>', ...xml, '</c:Symbols>']), DIAGRAM_COLLECTIONS);
    }
  }

  /**
   * Writes a moved symbol's rectangle (and a link's points), and stamps its
   * modification date like PowerDesigner does when a symbol is moved.
   */
  private geometry(symbolId: string, rect: PdmRect | null, points?: Array<[number, number]>): void {
    const node = this.object(symbolId);
    const set = (name: string, text: string) => {
      const el = node.child(name);
      if (!el) throw new PdmTreeError(`图形 ${symbolId} 缺少 <${name}>`);
      el.setText(text);
    };
    if (rect) set('a:Rect', formatRect(rect));
    if (points) set('a:ListOfPoints', formatPoints(points));
    node.child('a:ModificationDate')?.setText(this.stamp);
  }

  // ----- deletion and reference integrity --------------------------------

  /** Removes an object element from its collection and records its Ids. */
  private removeObject(id: string): void {
    const node = this.object(id);
    const parent = this.parentOf(node);
    parent.remove(node);
    this.markDeleted(node);
  }

  /** Records the Ids of `node` and everything nested in it as deleted. */
  private markDeleted(node: PNode): void {
    if (node.id) this.deleted.add(node.id);
    for (const c of node.children()) this.markDeleted(c);
  }

  /**
   * Removes `Ref`s to deleted objects the way PowerDesigner does when you
   * delete them there. Any other kind of reference means we do not know how
   * to delete safely, so saving fails instead of writing a broken file.
   */
  private cleanUpReferences(): void {
    if (this.deleted.size === 0) return;
    const dangling: Array<{ ref: PNode; coll: PNode; owner: PNode; ownerParent: PNode | null }> = [];
    const parents = new Map<PNode, PNode | null>();
    this.tree.walk((n, p) => {
      parents.set(n, p);
      if (n.ref && this.deleted.has(n.ref) && p) {
        const owner = parents.get(p);
        if (owner) dangling.push({ ref: n, coll: p, owner, ownerParent: parents.get(owner) ?? null });
      }
    });

    for (const { ref, coll, owner, ownerParent } of dangling) {
      switch (coll.name) {
        // A key or a reference's parent key loses the column/key; the key itself stays.
        case 'c:Key.Columns':
        case 'c:PrimaryKey':
        case 'c:ParentKey':
        case 'c:Object2':
          coll.remove(ref);
          break;
        // An index column of a deleted column is removed; the index stays.
        // PowerDesigner refers to the column twice (c:Column and c:Elements).
        case 'c:Column':
        case 'c:Elements':
          if (owner.name !== 'o:IndexColumn' || !ownerParent) throw this.danglingError(ref, owner);
          removeIfPresent(ownerParent, owner);
          break;
        // A join whose parent column is deleted is removed (PowerDesigner does the same).
        case 'c:Object1':
          if (owner.name !== 'o:ReferenceJoin' || !ownerParent) throw this.danglingError(ref, owner);
          removeIfPresent(ownerParent, owner);
          break;
        // A symbol of a deleted object, or a link attached to a deleted symbol, goes too.
        case 'c:Object':
        case 'c:SourceSymbol':
        case 'c:DestinationSymbol':
          if (!owner.name.endsWith('Symbol') || !ownerParent) throw this.danglingError(ref, owner);
          removeIfPresent(ownerParent, owner);
          break;
        default:
          throw this.danglingError(ref, owner);
      }
    }
  }

  private danglingError(ref: PNode, owner: PNode): PdmTreeError {
    return new PdmTreeError(
      `无法安全删除对象 ${ref.ref}：它仍被 <${owner.name}${owner.id ? ` Id="${owner.id}"` : ''}> 引用`,
    );
  }

  // ----- lookup helpers ---------------------------------------------------

  /** Node of an existing object; a missing one means the model and file disagree. */
  private object(id: string): PNode {
    const node = this.tree.byId(id);
    if (!node) throw new PdmTreeError(`对象 ${id} 在文件中不存在`);
    return node;
  }

  /** The collection element holding an original object. */
  private parentOf(node: PNode): PNode {
    const parentEl = node.el?.parent;
    if (!parentEl) throw new PdmTreeError(`对象 ${node.id} 没有所属集合`);
    return this.tree.wrap(parentEl);
  }

  // ----- XML for new objects (PowerDesigner 16.7.5 layout) ---------------

  private text(value: string): string {
    return encodeText(value.replace(/\r?\n/g, this.doc.xml.eol));
  }

  /** `ObjectID` … `Modifier` lines every new named object starts with. */
  private header(o: { objectId: string; name: string; code: string }): string[] {
    return [
      `<a:ObjectID>${o.objectId}</a:ObjectID>`,
      `<a:Name>${this.text(o.name)}</a:Name>`,
      `<a:Code>${this.text(o.code)}</a:Code>`,
      `<a:CreationDate>${this.stamp}</a:CreationDate>`,
      `<a:Creator>${this.user}</a:Creator>`,
      `<a:ModificationDate>${this.stamp}</a:ModificationDate>`,
      `<a:Modifier>${this.user}</a:Modifier>`,
    ];
  }

  private tableXml(t: PdmTable): string[] {
    const lines = [`<o:Table Id="${t.id}">`, ...this.header(t)];
    if (t.comment) lines.push(`<a:Comment>${this.text(t.comment)}</a:Comment>`);
    lines.push('<a:GlobalObjectID/>', '<a:TotalSavingCurrency/>');
    if (t.columns.length) lines.push('<c:Columns>', ...t.columns.flatMap((c) => this.columnXml(c)), '</c:Columns>');
    if (t.keys.length) lines.push('<c:Keys>', ...t.keys.flatMap((k) => this.keyXml(k)), '</c:Keys>');
    if (t.primaryKeyId) lines.push('<c:PrimaryKey>', `<o:Key Ref="${t.primaryKeyId}"/>`, '</c:PrimaryKey>');
    lines.push('</o:Table>');
    return lines;
  }

  private columnXml(c: PdmColumn): string[] {
    const lines = [`<o:Column Id="${c.id}">`, ...this.header(c)];
    if (c.comment) lines.push(`<a:Comment>${this.text(c.comment)}</a:Comment>`);
    if (c.defaultValue) lines.push(`<a:DefaultValue>${this.text(c.defaultValue)}</a:DefaultValue>`);
    if (c.dataType) {
      const { length, precision } = parseDataType(c.dataType);
      lines.push(`<a:DataType>${this.text(c.dataType)}</a:DataType>`);
      if (length !== null) lines.push(`<a:Length>${length}</a:Length>`);
      if (precision !== null) lines.push(`<a:Precision>${precision}</a:Precision>`);
    }
    if (c.mandatory) lines.push('<a:Column.Mandatory>1</a:Column.Mandatory>');
    lines.push('<a:GlobalObjectID/>');
    if (c.autoMigrated) lines.push('<a:AutoMigrated>1</a:AutoMigrated>');
    lines.push('</o:Column>');
    return lines;
  }

  /** Reference with PowerDesigner's defaults for a newly drawn one (restrict on update/delete). */
  private referenceXml(r: PdmReference): string[] {
    const lines = [`<o:Reference Id="${r.id}">`, ...this.header(r)];
    if (r.comment) lines.push(`<a:Comment>${this.text(r.comment)}</a:Comment>`);
    lines.push(
      '<a:GlobalObjectID/>',
      `<a:Cardinality>${this.text(r.cardinality)}</a:Cardinality>`,
      '<a:UpdateConstraint>1</a:UpdateConstraint>',
      '<a:DeleteConstraint>1</a:DeleteConstraint>',
      '<c:ParentTable>',
      `<o:Table Ref="${r.parentTableId}"/>`,
      '</c:ParentTable>',
      '<c:ChildTable>',
      `<o:Table Ref="${r.childTableId}"/>`,
      '</c:ChildTable>',
    );
    if (r.parentKeyId) lines.push('<c:ParentKey>', `<o:Key Ref="${r.parentKeyId}"/>`, '</c:ParentKey>');
    if (r.joins.length) {
      lines.push('<c:Joins>');
      for (const j of r.joins) {
        // Joins have no name or code; otherwise the usual header.
        lines.push(
          `<o:ReferenceJoin Id="${j.id}">`,
          `<a:ObjectID>${j.objectId}</a:ObjectID>`,
          `<a:CreationDate>${this.stamp}</a:CreationDate>`,
          `<a:Creator>${this.user}</a:Creator>`,
          `<a:ModificationDate>${this.stamp}</a:ModificationDate>`,
          `<a:Modifier>${this.user}</a:Modifier>`,
          '<a:GlobalObjectID/>',
        );
        if (j.parentColumnId) lines.push('<c:Object1>', `<o:Column Ref="${j.parentColumnId}"/>`, '</c:Object1>');
        if (j.childColumnId) lines.push('<c:Object2>', `<o:Column Ref="${j.childColumnId}"/>`, '</c:Object2>');
        lines.push('</o:ReferenceJoin>');
      }
      lines.push('</c:Joins>');
    }
    lines.push('</o:Reference>');
    return lines;
  }

  private keyXml(k: PdmKey): string[] {
    const lines = [`<o:Key Id="${k.id}">`, ...this.header(k), '<a:GlobalObjectID/>'];
    if (k.columnIds.length) {
      lines.push('<c:Key.Columns>', ...k.columnIds.map((id) => `<o:Column Ref="${id}"/>`), '</c:Key.Columns>');
    }
    lines.push('</o:Key>');
    return lines;
  }

  /** Table symbol with PowerDesigner's default style for new tables. */
  private tableSymbolXml(s: PdmTableSymbol): string[] {
    return [
      `<o:TableSymbol Id="${s.id}">`,
      `<a:CreationDate>${this.stamp}</a:CreationDate>`,
      `<a:ModificationDate>${this.stamp}</a:ModificationDate>`,
      '<a:IconMode>-1</a:IconMode>',
      `<a:Rect>${formatRect(s.rect)}</a:Rect>`,
      '<a:LineColor>16512</a:LineColor>',
      '<a:FillColor>166354</a:FillColor>',
      '<a:ShadowColor>12632256</a:ShadowColor>',
      '<a:FontList>STRN 0 Arial,8,N',
      'DISPNAME 0 Arial,8,N',
      'OWNRDISPNAME 0 新宋体,8,N',
      'Columns 0 Arial,8,N',
      'TablePkColumns 0 Arial,8,U',
      'TableFkColumns 0 Arial,8,N',
      'Keys 0 Arial,8,N',
      'Indexes 0 Arial,8,N',
      'Triggers 0 Arial,8,N',
      'LABL 0 Arial,8,N</a:FontList>',
      '<a:BrushStyle>6</a:BrushStyle>',
      '<a:GradientFillMode>65</a:GradientFillMode>',
      '<a:GradientEndColor>16777215</a:GradientEndColor>',
      '<c:Object>',
      `<o:Table Ref="${s.tableId}"/>`,
      '</c:Object>',
      '</o:TableSymbol>',
    ];
  }

  /** Reference link with PowerDesigner's default style (right angles, arrow at the parent). */
  private referenceSymbolXml(s: PdmReferenceSymbol): string[] {
    if (!s.sourceSymbolId || !s.destinationSymbolId) throw new PdmTreeError(`引用图形 ${s.id} 缺少端点`);
    return [
      `<o:ReferenceSymbol Id="${s.id}">`,
      `<a:CreationDate>${this.stamp}</a:CreationDate>`,
      `<a:ModificationDate>${this.stamp}</a:ModificationDate>`,
      `<a:Rect>${formatRect(s.rect)}</a:Rect>`,
      `<a:ListOfPoints>${formatPoints(s.points)}</a:ListOfPoints>`,
      `<a:CornerStyle>${s.orthogonal ? 2 : 0}</a:CornerStyle>`,
      '<a:ArrowStyle>1</a:ArrowStyle>',
      '<a:LineColor>4194432</a:LineColor>',
      '<a:ShadowColor>12632256</a:ShadowColor>',
      '<a:FontList>CENTER 0 新宋体,8,N',
      'SOURCE 0 新宋体,8,N',
      'DESTINATION 0 新宋体,8,N</a:FontList>',
      '<c:SourceSymbol>',
      `<o:TableSymbol Ref="${s.sourceSymbolId}"/>`,
      '</c:SourceSymbol>',
      '<c:DestinationSymbol>',
      `<o:TableSymbol Ref="${s.destinationSymbolId}"/>`,
      '</c:DestinationSymbol>',
      '<c:Object>',
      `<o:Reference Ref="${s.referenceId}"/>`,
      '</c:Object>',
      '</o:ReferenceSymbol>',
    ];
  }
}

/** `((x,y),(x,y),…)` as in PowerDesigner's `ListOfPoints` (no spaces). */
function formatPoints(points: Array<[number, number]>): string {
  return `(${points.map(([x, y]) => `(${Math.round(x)},${Math.round(y)})`).join(',')})`;
}

/** Removes `child` unless an earlier dangling reference already removed it. */
function removeIfPresent(parent: PNode, child: PNode): void {
  if (parent.children().includes(child)) parent.remove(child);
}

/** `((x1,y1), (x2,y2))` with PowerDesigner's y axis (pointing up). */
function formatRect(r: PdmRect | null): string {
  if (!r) throw new PdmTreeError('新图形缺少位置');
  return `((${Math.round(r.x1)},${Math.round(r.y1)}), (${Math.round(r.x2)},${Math.round(r.y2)}))`;
}
