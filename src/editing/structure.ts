/**
 * Structural edits: creating and deleting tables, columns, primary keys, and
 * diagram symbols. Each function is pure and returns a new model; the command
 * layer (`commands.ts`) wraps the result for undo/redo.
 *
 * Behavior follows PowerDesigner 16.7.5 (checked through its automation API):
 * - New objects are named `Table_n` / `Column_n` / `Key_n`, one above the
 *   highest existing number; Name and Code start out equal.
 * - A new column has no data type (PowerDesigner's "<Undefined>").
 * - Marking a column primary adds it to the primary key (creating the key if
 *   needed) and makes it mandatory; unmarking keeps it mandatory and keeps
 *   the key even when it becomes empty.
 * - Deleting a column removes it from keys and indexes; a reference join
 *   loses the column (parent side: the join is removed).
 * - Deleting a table removes its references and all symbols of both.
 * - Creating a reference migrates the parent's primary key columns into the
 *   child; deleting it removes those migrated columns again.
 */
import type {
  PdmColumn,
  PdmDiagram,
  PdmKey,
  PdmModel,
  PdmRect,
  PdmReference,
  PdmReferenceJoin,
  PdmReferenceSymbol,
  PdmTable,
  PdmTableSymbol,
} from '../pdm/types';

/** Size of a new table symbol in PowerDesigner units (as PD creates it). */
export const NEW_TABLE_SIZE = { width: 4800, height: 4000 };

// ---------------------------------------------------------------------------
// Ids and names
// ---------------------------------------------------------------------------

/** Every document-local Id used in the model (objects and symbols). */
function usedIds(model: PdmModel): number {
  let max = model.maxIdNum;
  const see = (id: string | null | undefined) => {
    const m = id ? /^o(\d+)$/.exec(id) : null;
    if (m) max = Math.max(max, Number(m[1]));
  };
  for (const t of model.tables) {
    see(t.id);
    t.columns.forEach((c) => see(c.id));
    t.keys.forEach((k) => see(k.id));
    t.indexes.forEach((x) => see(x.id));
  }
  for (const r of model.references) {
    see(r.id);
    r.joins.forEach((j) => see(j.id));
  }
  for (const d of model.diagrams) {
    see(d.id);
    d.tableSymbols.forEach((s) => see(s.id));
    d.referenceSymbols.forEach((s) => see(s.id));
  }
  return max;
}

/**
 * Returns `count` new Ids that are not used anywhere in the file or model.
 * Ids of undone objects may be reused; they no longer exist at that point.
 */
export function newIds(model: PdmModel, count: number): string[] {
  const start = usedIds(model) + 1;
  return Array.from({ length: count }, (_, i) => `o${start + i}`);
}

/** New random GUID in PowerDesigner's upper-case form. */
export function newGuid(): string {
  return crypto.randomUUID().toUpperCase();
}

/** `prefix_n` with n one above the highest existing `prefix_n` among `names`. */
export function nextName(prefix: string, names: Iterable<string>): string {
  const re = new RegExp(`^${prefix}_(\\d+)$`, 'i');
  let max = 0;
  for (const n of names) {
    const m = re.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}_${max + 1}`;
}

// ---------------------------------------------------------------------------
// Small immutable update helpers
// ---------------------------------------------------------------------------

function mapTable(model: PdmModel, tableId: string, fn: (t: PdmTable) => PdmTable): PdmModel {
  return { ...model, tables: model.tables.map((t) => (t.id === tableId ? fn(t) : t)) };
}

function mapDiagrams(model: PdmModel, fn: (d: PdmDiagram) => PdmDiagram): PdmModel {
  return { ...model, diagrams: model.diagrams.map(fn) };
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * Adds a new empty table with a symbol centered at `center` (PowerDesigner
 * units, y up) on the given diagram. The table goes into the model or
 * package that owns the diagram, as in PowerDesigner.
 */
export function addTable(
  model: PdmModel,
  diagramId: string,
  center: { x: number; y: number },
): { model: PdmModel; tableId: string } {
  const diagram = model.diagrams.find((d) => d.id === diagramId);
  if (!diagram) throw new Error(`关系图 ${diagramId} 不存在`);
  const [tableId, symbolId] = newIds(model, 2);
  const name = nextName(
    'Table',
    model.tables.flatMap((t) => [t.name, t.code]),
  );
  const table: PdmTable = {
    id: tableId,
    objectId: newGuid(),
    name,
    code: name,
    comment: '',
    parentId: diagram.parentId,
    ownerId: null,
    columns: [],
    keys: [],
    primaryKeyId: null,
    indexes: [],
  };
  const { width, height } = NEW_TABLE_SIZE;
  const rect: PdmRect = {
    x1: Math.round(center.x - width / 2),
    y1: Math.round(center.y - height / 2),
    x2: Math.round(center.x + width / 2),
    y2: Math.round(center.y + height / 2),
  };
  const symbol: PdmTableSymbol = { id: symbolId, tableId, rect };
  const next = mapDiagrams({ ...model, tables: [...model.tables, table] }, (d) =>
    d.id === diagramId ? { ...d, tableSymbols: [...d.tableSymbols, symbol] } : d,
  );
  return { model: next, tableId };
}

/**
 * Deletes tables with their references and every symbol of either; other
 * tables lose the foreign key columns migrated from a deleted table.
 */
export function deleteTables(model: PdmModel, tableIds: readonly string[]): PdmModel {
  const gone = new Set(tableIds);
  const deadRefs = new Set(
    model.references.filter((r) => gone.has(r.parentTableId) || gone.has(r.childTableId)).map((r) => r.id),
  );
  let next: PdmModel = {
    ...model,
    tables: model.tables.filter((t) => !gone.has(t.id)),
    references: model.references.filter((r) => !deadRefs.has(r.id)),
    diagrams: model.diagrams.map((d) => removeSymbols(d, (s) => gone.has(s.tableId), deadRefs)),
  };
  // Children of a deleted parent lose the columns migrated from it.
  for (const [tableId, columnIds] of migratedColumnsOf(model, deadRefs)) {
    if (!gone.has(tableId)) next = deleteColumns(next, tableId, columnIds);
  }
  return next;
}

/**
 * Deletes only the symbols of the given tables from one diagram ("仅删除图形");
 * the tables stay in the model. Reference links attached to them go as well.
 */
export function deleteTableSymbols(model: PdmModel, diagramId: string, tableIds: readonly string[]): PdmModel {
  const gone = new Set(tableIds);
  return mapDiagrams(model, (d) => (d.id === diagramId ? removeSymbols(d, (s) => gone.has(s.tableId), new Set()) : d));
}

/** Removes matching table symbols plus reference symbols attached to them or to dead references. */
function removeSymbols(d: PdmDiagram, drop: (s: PdmTableSymbol) => boolean, deadRefs: Set<string>): PdmDiagram {
  const dropped = new Set(d.tableSymbols.filter(drop).map((s) => s.id));
  if (dropped.size === 0 && !d.referenceSymbols.some((s) => deadRefs.has(s.referenceId))) return d;
  return {
    ...d,
    tableSymbols: d.tableSymbols.filter((s) => !dropped.has(s.id)),
    referenceSymbols: d.referenceSymbols.filter(
      (s) =>
        !deadRefs.has(s.referenceId) &&
        !dropped.has(s.sourceSymbolId ?? '') &&
        !dropped.has(s.destinationSymbolId ?? ''),
    ),
  };
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** Adds a new `Column_n` at `index` (default: at the end). */
export function addColumn(model: PdmModel, tableId: string, index?: number): { model: PdmModel; columnId: string } {
  const table = model.tables.find((t) => t.id === tableId);
  if (!table) throw new Error(`表 ${tableId} 不存在`);
  const [columnId] = newIds(model, 1);
  const name = nextName(
    'Column',
    table.columns.flatMap((c) => [c.name, c.code]),
  );
  const column: PdmColumn = {
    id: columnId,
    objectId: newGuid(),
    name,
    code: name,
    comment: '',
    dataType: '',
    length: null,
    precision: null,
    mandatory: false,
    defaultValue: '',
    autoMigrated: false,
  };
  const columns = [...table.columns];
  columns.splice(index ?? columns.length, 0, column);
  return { model: mapTable(model, tableId, (t) => ({ ...t, columns })), columnId };
}

/** Deletes columns and removes them from keys, indexes, and reference joins. */
export function deleteColumns(model: PdmModel, tableId: string, columnIds: readonly string[]): PdmModel {
  const gone = new Set(columnIds);
  const next = mapTable(model, tableId, (t) => ({
    ...t,
    columns: t.columns.filter((c) => !gone.has(c.id)),
    keys: t.keys.map((k) => (k.columnIds.some((id) => gone.has(id)) ? dropKeyColumns(k, gone) : k)),
    indexes: t.indexes.map((x) =>
      x.columnIds.some((id) => gone.has(id)) ? { ...x, columnIds: x.columnIds.filter((id) => !gone.has(id)) } : x,
    ),
  }));
  return { ...next, references: next.references.map((r) => dropJoinColumns(r, gone)) };
}

function dropKeyColumns(k: PdmKey, gone: Set<string>): PdmKey {
  return { ...k, columnIds: k.columnIds.filter((id) => !gone.has(id)) };
}

/** Parent column gone: the join is removed. Child column gone: the join stays without it. */
function dropJoinColumns(r: PdmReference, gone: Set<string>): PdmReference {
  if (!r.joins.some((j) => gone.has(j.parentColumnId ?? '') || gone.has(j.childColumnId ?? ''))) return r;
  return {
    ...r,
    joins: r.joins
      .filter((j) => !gone.has(j.parentColumnId ?? ''))
      .map((j) => (gone.has(j.childColumnId ?? '') ? { ...j, childColumnId: null } : j)),
  };
}

/** Moves a column up (`delta` -1) or down (+1) within its table. */
export function moveColumn(model: PdmModel, tableId: string, columnId: string, delta: number): PdmModel {
  return mapTable(model, tableId, (t) => {
    const from = t.columns.findIndex((c) => c.id === columnId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= t.columns.length) return t;
    const columns = [...t.columns];
    const [moved] = columns.splice(from, 1);
    columns.splice(to, 0, moved);
    return { ...t, columns };
  });
}

/**
 * The "P" checkbox: adds the column to the primary key (creating `Key_n` if
 * the table has none) and makes it mandatory, or removes it from the key.
 */
export function setPrimary(model: PdmModel, tableId: string, columnId: string, primary: boolean): PdmModel {
  const table = model.tables.find((t) => t.id === tableId);
  if (!table) return model;
  const pk = table.keys.find((k) => k.id === table.primaryKeyId);

  if (!primary) {
    if (!pk?.columnIds.includes(columnId)) return model;
    return mapTable(model, tableId, (t) => ({
      ...t,
      keys: t.keys.map((k) => (k.id === pk.id ? { ...k, columnIds: k.columnIds.filter((id) => id !== columnId) } : k)),
    }));
  }

  if (pk?.columnIds.includes(columnId)) return model;
  const columns = table.columns.map((c) => (c.id === columnId ? { ...c, mandatory: true } : c));
  if (pk) {
    return mapTable(model, tableId, (t) => ({
      ...t,
      columns,
      keys: t.keys.map((k) => (k.id === pk.id ? { ...k, columnIds: [...k.columnIds, columnId] } : k)),
    }));
  }
  const [keyId] = newIds(model, 1);
  const name = nextName(
    'Key',
    table.keys.flatMap((k) => [k.name, k.code]),
  );
  const key: PdmKey = { id: keyId, objectId: newGuid(), name, code: name, comment: '', columnIds: [columnId] };
  return mapTable(model, tableId, (t) => ({ ...t, columns, keys: [...t.keys, key], primaryKeyId: keyId }));
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/**
 * Deletes references and their symbols. Foreign key columns that
 * PowerDesigner migrated for a reference (`autoMigrated`) are deleted with
 * it, unless another reference still uses them; columns the user created
 * stay. Both verified in PowerDesigner 16.7.5.
 */
export function deleteReferences(model: PdmModel, referenceIds: readonly string[]): PdmModel {
  const gone = new Set(referenceIds);
  let next: PdmModel = {
    ...model,
    references: model.references.filter((r) => !gone.has(r.id)),
    diagrams: model.diagrams.map((d) => removeSymbols(d, () => false, gone)),
  };
  for (const [tableId, columnIds] of migratedColumnsOf(model, gone)) {
    next = deleteColumns(next, tableId, columnIds);
  }
  return next;
}

/**
 * Auto-migrated child columns of the `gone` references that no remaining
 * reference uses, grouped by table.
 */
function migratedColumnsOf(model: PdmModel, gone: Set<string>): Map<string, string[]> {
  const stillUsed = new Set(
    model.references.filter((r) => !gone.has(r.id)).flatMap((r) => r.joins.map((j) => j.childColumnId)),
  );
  const out = new Map<string, string[]>();
  for (const r of model.references) {
    if (!gone.has(r.id)) continue;
    const table = model.tables.find((t) => t.id === r.childTableId);
    for (const j of r.joins) {
      const col = table?.columns.find((c) => c.id === j.childColumnId);
      if (!table || !col?.autoMigrated || stillUsed.has(col.id)) continue;
      out.set(table.id, [...(out.get(table.id) ?? []), col.id]);
    }
  }
  return out;
}

/**
 * Creates a reference (foreign key) from the child table of `childSymbolId`
 * to the parent table of `parentSymbolId`, with its link on the diagram,
 * the way PowerDesigner 16.7.5 does when a reference is drawn:
 * - Named `Reference_n`; cardinality `0..*`; the parent key is the parent's
 *   primary key (none when the parent has none, and then no joins).
 * - For each parent key column, a child column with the same code, a
 *   compatible data type, and not yet used as a foreign key is reused.
 *   Otherwise the column is copied into the child (name, code, comment,
 *   data type, default; not mandatory) and marked auto-migrated.
 * - A copy whose code is already taken gets the first three characters of
 *   the parent's code / name as prefix (`T_U_ID`, `用户表_编号`); a name or
 *   code still taken gets a number appended (`编号2`).
 * - New columns go right after the child's last primary or foreign key column.
 * Child and parent may be the same table (self reference).
 */
export function addReference(
  model: PdmModel,
  diagramId: string,
  childSymbolId: string,
  parentSymbolId: string,
): { model: PdmModel; referenceId: string } {
  const diagram = model.diagrams.find((d) => d.id === diagramId);
  const childSym = diagram?.tableSymbols.find((s) => s.id === childSymbolId);
  const parentSym = diagram?.tableSymbols.find((s) => s.id === parentSymbolId);
  const child = model.tables.find((t) => t.id === childSym?.tableId);
  const parent = model.tables.find((t) => t.id === parentSym?.tableId);
  if (!diagram || !childSym || !parentSym || !child || !parent) throw new Error('引用的两端必须是关系图中的表');

  const parentKey = parent.keys.find((k) => k.id === parent.primaryKeyId) ?? null;
  const keyColumns = (parentKey?.columnIds ?? [])
    .map((id) => parent.columns.find((c) => c.id === id))
    .filter((c): c is PdmColumn => !!c);

  // Ids in one block: reference, symbol, then one join and maybe one column per key column.
  const ids = newIds(model, 2 + keyColumns.length * 2);
  const [referenceId, symbolId] = ids;
  let nextId = 2;

  // Child columns already used as foreign keys cannot be reused.
  const fkColumns = new Set(
    model.references.filter((r) => r.childTableId === child.id).flatMap((r) => r.joins.map((j) => j.childColumnId)),
  );
  const keyColumnIds = new Set(keyColumns.map((c) => c.id));
  const columns = [...child.columns];
  const childPk = new Set(child.keys.find((k) => k.id === child.primaryKeyId)?.columnIds ?? []);
  // Insert after the last primary or foreign key column (index of the slot).
  let insertAt = 0;
  columns.forEach((c, i) => {
    if (childPk.has(c.id) || fkColumns.has(c.id)) insertAt = i + 1;
  });

  const joins: PdmReferenceJoin[] = [];
  for (const pc of keyColumns) {
    const reuse = columns.find(
      (c) =>
        c.code === pc.code &&
        !fkColumns.has(c.id) &&
        !keyColumnIds.has(c.id) &&
        sameType(c.dataType, pc.dataType) &&
        !joins.some((j) => j.childColumnId === c.id),
    );
    let childColumnId: string;
    if (reuse) {
      childColumnId = reuse.id;
    } else {
      childColumnId = ids[nextId++];
      columns.splice(insertAt++, 0, migratedColumn(childColumnId, pc, parent, columns));
    }
    joins.push({ id: ids[nextId++], objectId: newGuid(), parentColumnId: pc.id, childColumnId });
  }

  const name = nextName(
    'Reference',
    model.references.flatMap((r) => [r.name, r.code]),
  );
  const reference: PdmReference = {
    id: referenceId,
    objectId: newGuid(),
    name,
    code: name,
    comment: '',
    parentId: diagram.parentId,
    parentTableId: parent.id,
    childTableId: child.id,
    parentKeyId: parentKey?.id ?? null,
    cardinality: '0..*',
    joins,
  };
  const points = routeNewLink(childSym.rect, parentSym.rect, childSymbolId === parentSymbolId);
  const symbol: PdmReferenceSymbol = {
    id: symbolId,
    referenceId,
    sourceSymbolId: childSymbolId,
    destinationSymbolId: parentSymbolId,
    rect: pointsRect(points),
    points,
    orthogonal: true,
  };

  const next = mapDiagrams(
    mapTable({ ...model, references: [...model.references, reference] }, child.id, (t) => ({ ...t, columns })),
    (d) => (d.id === diagramId ? { ...d, referenceSymbols: [...d.referenceSymbols, symbol] } : d),
  );
  return { model: next, referenceId };
}

/**
 * Copy of a parent key column for the child table. `existing` are the
 * child's columns; name and code are made unique among them.
 */
function migratedColumn(id: string, pc: PdmColumn, parent: PdmTable, existing: readonly PdmColumn[]): PdmColumn {
  const taken = (attr: 'name' | 'code', v: string) => existing.some((c) => c[attr].toLowerCase() === v.toLowerCase());
  let name = pc.name;
  let code = pc.code;
  // Only a code clash triggers the parent prefix; it then applies to both.
  if (taken('code', code)) {
    code = `${parent.code.slice(0, 3)}_${code}`;
    name = `${parent.name.slice(0, 3)}_${name}`;
  }
  const unique = (attr: 'name' | 'code', v: string) => {
    if (!taken(attr, v)) return v;
    let n = 2;
    while (taken(attr, `${v}${n}`)) n++;
    return `${v}${n}`;
  };
  return {
    id,
    objectId: newGuid(),
    name: unique('name', name),
    code: unique('code', code),
    comment: pc.comment,
    dataType: pc.dataType,
    length: pc.length,
    precision: pc.precision,
    mandatory: false,
    defaultValue: pc.defaultValue,
    autoMigrated: true,
  };
}

/** Data types match ignoring case; an empty type matches anything (as in PowerDesigner). */
function sameType(a: string, b: string): boolean {
  return !a || !b || a.toLowerCase() === b.toLowerCase();
}

/** Distance of a self reference loop from the table (PowerDesigner draws about 2000). */
const SELF_LOOP = 2000;

/**
 * Right-angled route of a new link from the child's center to the parent's
 * center, as PowerDesigner lays it out when a reference is created:
 * - centers in line, or tables overlapping: a straight line;
 * - tables side by side: a Z with its vertical middle segment halfway
 *   between their facing edges (rounded down); above each other: the same
 *   with a horizontal middle segment;
 * - tables diagonal to each other: an L, leaving the child vertically;
 * - self reference: a loop out of the right side and over the top.
 */
export function routeNewLink(src: PdmRect | null, dst: PdmRect | null, self: boolean): Array<[number, number]> {
  if (!src || !dst) return [];
  const center = (r: PdmRect): [number, number] => [Math.floor((r.x1 + r.x2) / 2), Math.floor((r.y1 + r.y2) / 2)];
  const [sx, sy] = center(src);
  const [dx, dy] = center(dst);
  if (self) {
    const x = src.x2 + SELF_LOOP;
    const y = src.y2 + SELF_LOOP;
    return [
      [sx, sy],
      [x, sy],
      [x, y],
      [sx, y],
      [sx, sy],
    ];
  }
  if (sx === dx || sy === dy) {
    return [
      [sx, sy],
      [dx, dy],
    ];
  }
  const apartX = src.x2 < dst.x1 || dst.x2 < src.x1;
  const apartY = src.y2 < dst.y1 || dst.y2 < src.y1;
  if (apartX && apartY) {
    return [
      [sx, sy],
      [sx, dy],
      [dx, dy],
    ];
  }
  if (apartX) {
    const mx = Math.floor(src.x2 < dst.x1 ? (src.x2 + dst.x1) / 2 : (dst.x2 + src.x1) / 2);
    return [
      [sx, sy],
      [mx, sy],
      [mx, dy],
      [dx, dy],
    ];
  }
  if (apartY) {
    const my = Math.floor(src.y2 < dst.y1 ? (src.y2 + dst.y1) / 2 : (dst.y2 + src.y1) / 2);
    return [
      [sx, sy],
      [sx, my],
      [dx, my],
      [dx, dy],
    ];
  }
  return [
    [sx, sy],
    [dx, dy],
  ];
}

/** Margin PowerDesigner keeps around a link's points for its labels (approximately). */
const LINK_MARGIN = 225;

/** Bounding box of a new link, with room for its labels. */
function pointsRect(points: Array<[number, number]>): PdmRect | null {
  if (points.length === 0) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    x1: Math.min(...xs) - LINK_MARGIN,
    y1: Math.min(...ys) - LINK_MARGIN,
    x2: Math.max(...xs) + LINK_MARGIN,
    y2: Math.max(...ys) + LINK_MARGIN,
  };
}

// ---------------------------------------------------------------------------
// Diagram layout
// ---------------------------------------------------------------------------

/** One table symbol moved by (dx, dy) in PowerDesigner units (y up). */
export interface SymbolMove {
  symbolId: string;
  dx: number;
  dy: number;
}

/**
 * Moves table symbols in one diagram and keeps attached reference links
 * connected. PowerDesigner does not repair stale link points when it opens
 * a file (verified), so the links must be updated here: the end attached to
 * a moved table moves with it, keeping its attachment point; when both
 * tables move by the same offset, the whole link moves.
 */
export function moveTableSymbols(model: PdmModel, diagramId: string, moves: readonly SymbolMove[]): PdmModel {
  const delta = new Map(moves.filter((m) => m.dx !== 0 || m.dy !== 0).map((m) => [m.symbolId, m]));
  if (delta.size === 0) return model;
  return mapDiagrams(model, (d) => {
    if (d.id !== diagramId) return d;
    return {
      ...d,
      tableSymbols: d.tableSymbols.map((s) => {
        const m = delta.get(s.id);
        return m && s.rect ? { ...s, rect: shiftRect(s.rect, m.dx, m.dy) } : s;
      }),
      referenceSymbols: d.referenceSymbols.map((rs) => {
        const src = delta.get(rs.sourceSymbolId ?? '');
        const dst = delta.get(rs.destinationSymbolId ?? '');
        if (!src && !dst) return rs;
        let points = movePoints(rs.points, src, dst);
        if (rs.orthogonal && !(src && dst && src.dx === dst.dx && src.dy === dst.dy)) {
          // Rectangles after the move, for routing a straight link around them.
          const rectOf = (id: string | null) => {
            const s = d.tableSymbols.find((x) => x.id === id);
            const m = delta.get(id ?? '');
            return s?.rect ? (m ? shiftRect(s.rect, m.dx, m.dy) : s.rect) : null;
          };
          points = keepOrthogonal(rs.points, points, rectOf(rs.sourceSymbolId), rectOf(rs.destinationSymbolId));
        }
        return { ...rs, points, rect: rs.rect && followRect(rs.rect, rs.points, points) };
      }),
    };
  });
}

/**
 * Restores right angles after an end of an orthogonal link moved, the way
 * PowerDesigner does when it opens such a file (verified against its output):
 * - with bends: the point next to a moved end follows it, so the first/last
 *   segment keeps its horizontal or vertical direction;
 * - a straight two-point link that became diagonal turns into a Z whose
 *   middle segment lies halfway between the facing edges of the two tables.
 */
function keepOrthogonal(
  before: Array<[number, number]>,
  after: Array<[number, number]>,
  srcRect: PdmRect | null,
  dstRect: PdmRect | null,
): Array<[number, number]> {
  const pts = after.map(([x, y]) => [x, y] as [number, number]);
  const n = pts.length;
  if (n < 2) return pts;

  if (n === 2) {
    const [[ax, ay], [bx, by]] = pts;
    if (ax === bx || ay === by || !srcRect || !dstRect) return pts;
    // Tables side by side: vertical middle segment between their facing edges.
    // PowerDesigner rounds the halfway point down (integer division).
    if (srcRect.x2 < dstRect.x1 || dstRect.x2 < srcRect.x1) {
      const mx = Math.floor(srcRect.x2 < dstRect.x1 ? (srcRect.x2 + dstRect.x1) / 2 : (dstRect.x2 + srcRect.x1) / 2);
      return [pts[0], [mx, ay], [mx, by], pts[1]];
    }
    // Tables above each other: horizontal middle segment instead.
    if (srcRect.y2 < dstRect.y1 || dstRect.y2 < srcRect.y1) {
      const my = Math.floor(srcRect.y2 < dstRect.y1 ? (srcRect.y2 + dstRect.y1) / 2 : (dstRect.y2 + srcRect.y1) / 2);
      return [pts[0], [ax, my], [bx, my], pts[1]];
    }
    // Overlapping tables: no clean route, keep the straight link.
    return pts;
  }

  // Ends: index 0 with neighbor 1, index n-1 with neighbor n-2.
  for (const [end, next] of [
    [0, 1],
    [n - 1, n - 2],
  ]) {
    if (pts[end][0] === before[end][0] && pts[end][1] === before[end][1]) continue;
    if (before[end][1] === before[next][1]) pts[next] = [pts[next][0], pts[end][1]];
    else if (before[end][0] === before[next][0]) pts[next] = [pts[end][0], pts[next][1]];
  }
  return pts;
}

function shiftRect(r: PdmRect, dx: number, dy: number): PdmRect {
  return { x1: r.x1 + dx, y1: r.y1 + dy, x2: r.x2 + dx, y2: r.y2 + dy };
}

/** First point belongs to the source symbol, last to the destination. */
function movePoints(
  points: Array<[number, number]>,
  src: SymbolMove | undefined,
  dst: SymbolMove | undefined,
): Array<[number, number]> {
  // Both ends moved together: translate the whole polyline.
  if (src && dst && src.dx === dst.dx && src.dy === dst.dy) {
    return points.map(([x, y]) => [x + src.dx, y + src.dy]);
  }
  const out = points.map(([x, y]) => [x, y] as [number, number]);
  const last = out.length - 1;
  if (src && last >= 0) out[0] = [out[0][0] + src.dx, out[0][1] + src.dy];
  if (dst && last >= 0) out[last] = [out[last][0] + dst.dx, out[last][1] + dst.dy];
  return out;
}

/** Keeps the link's label margins around its points' new bounding box. */
function followRect(rect: PdmRect, before: Array<[number, number]>, after: Array<[number, number]>): PdmRect {
  const box = (ps: Array<[number, number]>) => ({
    x1: Math.min(...ps.map((p) => p[0])),
    y1: Math.min(...ps.map((p) => p[1])),
    x2: Math.max(...ps.map((p) => p[0])),
    y2: Math.max(...ps.map((p) => p[1])),
  });
  if (before.length === 0 || after.length === 0) return rect;
  const a = box(before);
  const b = box(after);
  return {
    x1: b.x1 - (a.x1 - rect.x1),
    y1: b.y1 - (a.y1 - rect.y1),
    x2: b.x2 + (rect.x2 - a.x2),
    y2: b.y2 + (rect.y2 - a.y2),
  };
}
