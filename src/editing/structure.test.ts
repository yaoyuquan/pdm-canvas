/**
 * Structural edits end to end: edit the model with the command-layer
 * functions, write it into the original text, read the result back, and
 * check both the model and that untouched parts of the file are unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { instantiateTemplate, readPdm, writeModel, diffModel, type PdmModel } from '../pdm';
import {
  addColumn,
  addReference,
  addTable,
  deleteColumns,
  deleteReferences,
  deleteTables,
  deleteTableSymbols,
  moveColumn,
  moveTableSymbols,
  nextName,
  routeNewLink,
  setPrimary,
} from './structure';
import { setAttr } from './commands';

const ROOT = path.resolve(__dirname, '../..');
const src = fs.readFileSync(path.join(ROOT, 'test-fixtures/synthetic/minimal.pdm'), 'utf8');
const doc = readPdm(src);
const base = doc.model;
const ctx = { user: 'tester', now: new Date('2026-11-20T00:00:00Z') };

/** Saves `model` into the fixture, re-reads it, and checks file integrity. */
function save(model: PdmModel, from = doc, text = src) {
  const out = writeModel(from, model, ctx);
  const again = readPdm(out);
  expectRefsResolve(out);
  // CRLF only, like PowerDesigner.
  expect(out).not.toMatch(/[^\r]\n/);
  // Nothing left to write: the saved file holds exactly the edited model.
  expect(diffModel(model, again.model)).toEqual([]);
  return { out, model: again.model, text };
}

/** Every `Ref="oN"` must point at an `Id="oN"` in the same file. */
function expectRefsResolve(text: string) {
  const ids = new Set([...text.matchAll(/ Id="(o\d+)"/g)].map((m) => m[1]));
  const dangling = [...text.matchAll(/ Ref="(o\d+)"/g)].map((m) => m[1]).filter((r) => !ids.has(r));
  expect(dangling).toEqual([]);
}

describe('naming and ids', () => {
  it('numbers new objects one above the highest existing number', () => {
    expect(nextName('Table', [])).toBe('Table_1');
    expect(nextName('Table', ['Table_2', 'CUSTOMER', 'table_7'])).toBe('Table_8');
  });

  it('reads the highest Id of the whole file, not just of the model objects', () => {
    const highest = Math.max(...[...src.matchAll(/ Id="o(\d+)"/g)].map((m) => Number(m[1])));
    expect(base.maxIdNum).toBe(highest);
  });

  it('allocates ids above everything in the file', () => {
    const { model } = addTable(base, 'o3', { x: 0, y: 0 });
    const t = model.tables[2];
    expect(Number(t.id.slice(1))).toBeGreaterThan(base.maxIdNum);
  });
});

describe('add table', () => {
  it('writes a new table, columns, primary key and symbol in PowerDesigner layout', () => {
    let { model, tableId } = addTable(base, 'o3', { x: 20000, y: -3000 });
    let r = addColumn(model, tableId);
    model = r.model;
    const idCol = r.columnId;
    model = setAttr(model, { kind: 'column', tableId, columnId: idCol }, 'DataType', 'NUMBER(18)');
    model = setPrimary(model, tableId, idCol, true);
    r = addColumn(model, tableId);
    model = setAttr(r.model, { kind: 'column', tableId, columnId: r.columnId }, 'Comment', '备注 "x"');

    const saved = save(model);
    const t = saved.model.tables.find((x) => x.id === tableId)!;
    expect(t).toMatchObject({ name: 'Table_1', code: 'Table_1', parentId: 'o2' });
    expect(t.columns.map((c) => [c.code, c.dataType, c.mandatory])).toEqual([
      ['Column_1', 'NUMBER(18)', true],
      ['Column_2', '', false],
    ]);
    expect(t.keys).toHaveLength(1);
    expect(t.keys[0]).toMatchObject({ code: 'Key_1', columnIds: [idCol] });
    expect(t.primaryKeyId).toBe(t.keys[0].id);
    const sym = saved.model.diagrams[0].tableSymbols.find((s) => s.tableId === tableId)!;
    expect(sym.rect).toEqual({ x1: 17600, y1: -5000, x2: 22400, y2: -1000 });

    // Exact PowerDesigner element order inside the new column and table.
    expect(saved.out).toContain(
      `<a:Modifier>tester</a:Modifier>\r\n<a:DataType>NUMBER(18)</a:DataType>\r\n<a:Length>18</a:Length>\r\n<a:Column.Mandatory>1</a:Column.Mandatory>\r\n<a:GlobalObjectID/>\r\n</o:Column>`,
    );
    expect(saved.out).toContain('<a:Comment>备注 &quot;x&quot;</a:Comment>');
    expect(saved.out).toMatch(
      /<a:TotalSavingCurrency\/>\r\n<c:Columns>[\s\S]*<\/c:Columns>\r\n<c:Keys>[\s\S]*<\/c:Keys>\r\n<c:PrimaryKey>/,
    );

    // Existing tables are untouched: the file up to the new symbol is identical.
    const firstChange = [...src].findIndex((ch, i) => saved.out[i] !== ch);
    expect(src.slice(0, firstChange)).toContain('<o:Table Ref="o8"/>');
  });

  it('creates c:Tables and c:Symbols in an empty new model', () => {
    const tpl = fs.readFileSync(path.join(ROOT, 'resources/templates/mysql50.pdm'), 'utf8');
    const text = instantiateTemplate(tpl, { user: 'u', now: ctx.now, newGuid: () => crypto.randomUUID() });
    const empty = readPdm(text);
    const diagramId = empty.model.diagrams[0].id;
    const { model, tableId } = addTable(empty.model, diagramId, { x: 0, y: 0 });
    const out = writeModel(empty, model, ctx);
    const again = readPdm(out).model;
    expect(again.tables.map((t) => t.id)).toEqual([tableId]);
    expect(again.diagrams[0].tableSymbols.map((s) => s.tableId)).toEqual([tableId]);
    // Collections land where PowerDesigner puts them.
    expect(out).toMatch(/<\/c:DefaultDiagram>\r\n<c:Tables>/);
    expect(out).toMatch(/<a:PaperSource>1<\/a:PaperSource>\r\n<c:Symbols>/);
    expectRefsResolve(out);
  });
});

describe('columns', () => {
  it('reorders columns, keeping each column byte-identical', () => {
    const model = moveColumn(base, 'o8', 'o14', -2);
    const saved = save(model);
    expect(saved.model.tables[1].columns.map((c) => c.code)).toEqual(['CREATED_AT', 'ORDER_ID', 'CUSTOMER_ID']);
    const col = (text: string, id: string) => {
      const el = readPdm(text).byId.get(id)!;
      return text.slice(el.start, el.end);
    };
    expect(col(saved.out, 'o14')).toBe(col(src, 'o14'));
    expect(saved.out.length).toBe(src.length);
  });

  it('deleting a column removes it from keys, indexes, and reference joins', () => {
    // CUSTOMER_ID of SALES_ORDER is in an index and is the child side of the FK.
    let model = deleteColumns(base, 'o8', ['o13']);
    let saved = save(model);
    const order = saved.model.tables[1];
    expect(order.columns.map((c) => c.code)).toEqual(['ORDER_ID', 'CREATED_AT']);
    expect(order.indexes[0].columnIds).toEqual([]);
    expect(saved.model.references[0].joins).toEqual([
      { id: 'o21', objectId: base.references[0].joins[0].objectId, parentColumnId: 'o9', childColumnId: null },
    ]);

    // CUSTOMER_ID of CUSTOMER is the primary key and the parent side of the FK.
    model = deleteColumns(base, 'o7', ['o9']);
    saved = save(model);
    const customer = saved.model.tables[0];
    expect(customer.keys[0].columnIds).toEqual([]);
    expect(customer.primaryKeyId).toBe('o11');
    expect(saved.model.references[0].joins).toEqual([]);
  });

  it('marks and unmarks primary key columns like PowerDesigner', () => {
    let model = setPrimary(base, 'o8', 'o13', true);
    expect(model.tables[1].columns[1].mandatory).toBe(true);
    let saved = save(model);
    expect(saved.model.tables[1].keys[0].columnIds).toEqual(['o12', 'o13']);

    model = setPrimary(base, 'o8', 'o12', false);
    saved = save(model);
    expect(saved.model.tables[1].keys[0].columnIds).toEqual([]);
    // The column stays mandatory and the key stays, as in PowerDesigner.
    expect(saved.model.tables[1].columns[0].mandatory).toBe(true);
    expect(saved.model.tables[1].primaryKeyId).toBe('o15');
  });
});

describe('delete table', () => {
  it('deletes the table with its references and symbols', () => {
    const model = deleteTables(base, ['o7']);
    expect(model.references).toEqual([]);
    expect(model.diagrams[0].tableSymbols.map((s) => s.id)).toEqual(['o6']);
    expect(model.diagrams[0].referenceSymbols).toEqual([]);
    const saved = save(model);
    expect(saved.model.tables.map((t) => t.code)).toEqual(['SALES_ORDER']);
    expect(saved.out).not.toContain('<c:References>');
    expect(saved.out).not.toContain('FK_ORDER_CUSTOMER');
  });

  it('deleting only the symbol keeps the table in the model', () => {
    const model = deleteTableSymbols(base, 'o3', ['o7']);
    const saved = save(model);
    expect(saved.model.tables.map((t) => t.code)).toEqual(['CUSTOMER', 'SALES_ORDER']);
    expect(saved.model.references).toHaveLength(1);
    expect(saved.model.diagrams[0].tableSymbols.map((s) => s.tableId)).toEqual(['o8']);
    expect(saved.model.diagrams[0].referenceSymbols).toEqual([]);
  });

  it('writes nothing when edits are undone', () => {
    const { model } = addTable(base, 'o3', { x: 0, y: 0 });
    expect(diffModel(base, model).length).toBeGreaterThan(0);
    expect(writeModel(doc, base, ctx)).toBe(src);
  });
});

describe('delete reference', () => {
  it('removes the reference and its symbol but keeps the FK column', () => {
    const saved = save(deleteReferences(base, ['o20']));
    expect(saved.model.references).toEqual([]);
    expect(saved.model.diagrams[0].referenceSymbols).toEqual([]);
    expect(saved.model.tables[1].columns.map((c) => c.code)).toContain('CUSTOMER_ID');
  });
});

describe('move table symbols', () => {
  /** Lines that differ between two texts (same line count expected). */
  const changedLines = (a: string, b: string) => {
    const la = a.split('\r\n');
    const lb = b.split('\r\n');
    expect(lb.length).toBe(la.length);
    return lb.filter((line, i) => line !== la[i]);
  };

  it('moves a table and the attached end of its reference link', () => {
    // CUSTOMER (o5) is the link's destination: its last point moves along.
    const model = moveTableSymbols(base, 'o3', [{ symbolId: 'o5', dx: -2000, dy: 500 }]);
    const saved = save(model);
    const d = saved.model.diagrams[0];
    expect(d.tableSymbols[0].rect).toEqual({ x1: -17000, y1: -4500, x2: -3000, y2: 6500 });
    expect(d.referenceSymbols[0].points).toEqual([
      [10000, 600],
      [-3000, 1100],
    ]);
    // Only the two rectangles, the link points, and two modification dates change.
    expect(changedLines(src, saved.out)).toEqual([
      '<a:ModificationDate>1795132800</a:ModificationDate>',
      '<a:Rect>((-3000,0), (10000,1700))</a:Rect>',
      '<a:ListOfPoints>((10000,600),(-3000,1100))</a:ListOfPoints>',
      '<a:ModificationDate>1795132800</a:ModificationDate>',
      '<a:Rect>((-17000,-4500), (-3000,6500))</a:Rect>',
    ]);
  });

  it('moves the whole link when both tables move together', () => {
    const moves = ['o5', 'o6'].map((symbolId) => ({ symbolId, dx: 1000, dy: -1000 }));
    const saved = save(moveTableSymbols(base, 'o3', moves));
    expect(saved.model.diagrams[0].referenceSymbols[0].points).toEqual([
      [11000, -400],
      [0, -400],
    ]);
  });

  it('writes nothing for a zero move', () => {
    expect(moveTableSymbols(base, 'o3', [{ symbolId: 'o5', dx: 0, dy: 0 }])).toBe(base);
  });
});

describe('orthogonal links follow PowerDesigner routing', () => {
  /** The fixture's link, marked as right-angled (CornerStyle 2) with the given points. */
  const withLink = (points: Array<[number, number]>): PdmModel => ({
    ...base,
    diagrams: base.diagrams.map((d) => ({
      ...d,
      referenceSymbols: d.referenceSymbols.map((r) => ({ ...r, orthogonal: true, points })),
    })),
  });
  const linkAfter = (m: PdmModel) => m.diagrams[0].referenceSymbols[0].points;

  it('turns a straight link that became diagonal into a Z between the facing edges', () => {
    // SALES_ORDER (o6, x 10000..25000) -> CUSTOMER (o5, x -15000..-1000); move CUSTOMER down.
    const m = moveTableSymbols(
      withLink([
        [10000, 600],
        [-1000, 600],
      ]),
      'o3',
      [{ symbolId: 'o5', dx: 0, dy: -3001 }],
    );
    // Halfway between -1000 and 10000 is 4500; PowerDesigner rounds halves down.
    expect(linkAfter(m)).toEqual([
      [10000, 600],
      [4500, 600],
      [4500, -2401],
      [-1000, -2401],
    ]);
  });

  it('moves the neighbor of a moved end so the end segment stays straight', () => {
    const bent: Array<[number, number]> = [
      [10000, 600],
      [5000, 600],
      [5000, 3000],
      [-1000, 3000],
    ];
    const m = moveTableSymbols(withLink(bent), 'o3', [{ symbolId: 'o5', dx: -500, dy: 1000 }]);
    // Last segment was horizontal: its other point takes the new y.
    expect(linkAfter(m)).toEqual([
      [10000, 600],
      [5000, 600],
      [5000, 4000],
      [-1500, 4000],
    ]);
  });
});

describe('add reference', () => {
  // Fixture: SALES_ORDER (table o8, symbol o6) -> CUSTOMER (table o7, symbol o5)
  // already exists as o20, joining CUSTOMER.CUSTOMER_ID (o9) to SALES_ORDER.CUSTOMER_ID (o13).
  const codes = (m: PdmModel, tableId: string) => m.tables.find((t) => t.id === tableId)!.columns.map((c) => c.code);

  it('migrates the parent key into the child with a prefix when the code is taken', () => {
    const { model, referenceId } = addReference(base, 'o3', 'o6', 'o5');
    const saved = save(model);
    const r = saved.model.references.find((x) => x.id === referenceId)!;
    expect(r).toMatchObject({
      name: 'Reference_1',
      code: 'Reference_1',
      parentTableId: 'o7',
      childTableId: 'o8',
      parentKeyId: 'o11',
      cardinality: '0..*',
      parentId: 'o2',
    });
    // CUSTOMER_ID is already a foreign key, so a prefixed copy is added after it.
    expect(codes(saved.model, 'o8')).toEqual(['ORDER_ID', 'CUSTOMER_ID', 'CUS_CUSTOMER_ID', 'CREATED_AT']);
    const fk = saved.model.tables[1].columns[2];
    expect(fk).toMatchObject({ name: '客户_客户ID', dataType: 'NUMBER(18)', mandatory: false, autoMigrated: true });
    expect(r.joins).toEqual([
      { id: r.joins[0].id, objectId: r.joins[0].objectId, parentColumnId: 'o9', childColumnId: fk.id },
    ]);

    // The link goes from the child to the parent, as a Z between the facing edges.
    const link = saved.model.diagrams[0].referenceSymbols.find((s) => s.referenceId === referenceId)!;
    expect(link).toMatchObject({ sourceSymbolId: 'o6', destinationSymbolId: 'o5', orthogonal: true });
    // Centers at the same height: a straight line.
    expect(link.points).toEqual([
      [17500, 500],
      [-8000, 500],
    ]);
    // PowerDesigner's element layout, and links before table symbols.
    expect(saved.out).toContain('<a:GlobalObjectID/>\r\n<a:AutoMigrated>1</a:AutoMigrated>\r\n</o:Column>');
    expect(saved.out).toMatch(
      /<a:Cardinality>0\.\.\*<\/a:Cardinality>\r\n<a:UpdateConstraint>1<\/a:UpdateConstraint>\r\n<a:DeleteConstraint>1<\/a:DeleteConstraint>\r\n<c:ParentTable>/,
    );
    expect(saved.out.indexOf(`<o:ReferenceSymbol Id="${link.id}">`)).toBeLessThan(
      saved.out.indexOf('<o:TableSymbol Id="o5">'),
    );
    expect(saved.out.indexOf(`<o:ReferenceSymbol Id="${link.id}">`)).toBeGreaterThan(
      saved.out.indexOf('<o:ReferenceSymbol Id="o4">'),
    );
  });

  it('reuses a free child column with the same code and type', () => {
    // Without the old reference, SALES_ORDER.CUSTOMER_ID (user-made) is free again.
    const { model, referenceId } = addReference(deleteReferences(base, ['o20']), 'o3', 'o6', 'o5');
    const saved = save(model);
    expect(codes(saved.model, 'o8')).toEqual(['ORDER_ID', 'CUSTOMER_ID', 'CREATED_AT']);
    expect(saved.model.references.find((r) => r.id === referenceId)!.joins[0].childColumnId).toBe('o13');
  });

  it('creates a self reference with a loop link', () => {
    const { model, referenceId } = addReference(base, 'o3', 'o5', 'o5');
    const saved = save(model);
    // The key column itself is never reused; the copy goes after the last key column.
    expect(codes(saved.model, 'o7')).toEqual(['CUSTOMER_ID', 'CUS_CUSTOMER_ID', 'CUSTOMER_NAME']);
    const link = saved.model.diagrams[0].referenceSymbols.find((s) => s.referenceId === referenceId)!;
    expect(link.points).toEqual([
      [-8000, 500],
      [1000, 500],
      [1000, 8000],
      [-8000, 8000],
      [-8000, 500],
    ]);
  });

  it('a parent without primary key gives a reference without joins', () => {
    const noPk = { ...base, tables: base.tables.map((t) => (t.id === 'o7' ? { ...t, primaryKeyId: null } : t)) };
    const { model, referenceId } = addReference(noPk, 'o3', 'o6', 'o5');
    const r = model.references.find((x) => x.id === referenceId)!;
    expect(r.parentKeyId).toBeNull();
    expect(r.joins).toEqual([]);
    expect(codes(model, 'o8')).toEqual(codes(base, 'o8'));
  });

  it('deleting the reference or its parent table removes the migrated column', () => {
    const { model, referenceId } = addReference(base, 'o3', 'o6', 'o5');
    expect(codes(deleteReferences(model, [referenceId]), 'o8')).toEqual(codes(base, 'o8'));
    // CUSTOMER deleted: both references go; only the migrated column goes with them.
    const saved = save(deleteTables(model, ['o7']));
    expect(codes(saved.model, 'o8')).toEqual(['ORDER_ID', 'CUSTOMER_ID', 'CREATED_AT']);
    expect(saved.out).not.toContain('<c:References>');
  });

  it('writes c:References into a new model', () => {
    const tpl = fs.readFileSync(path.join(ROOT, 'resources/templates/oracle11g.pdm'), 'utf8');
    const empty = readPdm(instantiateTemplate(tpl, { user: 'u', now: ctx.now, newGuid: () => crypto.randomUUID() }));
    const diagramId = empty.model.diagrams[0].id;
    let { model, tableId: parentId } = addTable(empty.model, diagramId, { x: -10000, y: 0 });
    const col = addColumn(model, parentId);
    model = setPrimary(col.model, parentId, col.columnId, true);
    const child = addTable(model, diagramId, { x: 10000, y: 0 });
    const sym = (m: PdmModel, t: string) => m.diagrams[0].tableSymbols.find((s) => s.tableId === t)!.id;
    const added = addReference(child.model, diagramId, sym(child.model, child.tableId), sym(child.model, parentId));
    const out = writeModel(empty, added.model, ctx);
    const again = readPdm(out).model;
    expect(again.references).toHaveLength(1);
    expect(again.tables[1].columns.map((c) => [c.code, c.autoMigrated])).toEqual([['Column_1', true]]);
    expect(out).toMatch(/<\/c:Tables>\r\n<c:References>/);
    expectRefsResolve(out);
    // Every Id in the file is unique.
    const ids = [...out.matchAll(/ Id="(o\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('new link routing matches PowerDesigner', () => {
  // Rectangles and expected points taken from links PowerDesigner 16.7.5 created.
  const child = { x1: -20675, y1: -719, x2: -9325, y2: 3719 };

  it('side by side: Z with the middle halfway between the facing edges', () => {
    expect(routeNewLink(child, { x1: 4233, y1: 1000, x2: 15767, y2: 5000 }, false)).toEqual([
      [-15000, 1500],
      [-2546, 1500],
      [-2546, 3000],
      [10000, 3000],
    ]);
  });

  it('diagonal: L leaving the child vertically', () => {
    expect(routeNewLink(child, { x1: 4233, y1: 11000, x2: 15767, y2: 15000 }, false)).toEqual([
      [-15000, 1500],
      [-15000, 13000],
      [10000, 13000],
    ]);
  });

  it('above each other: Z with a horizontal middle', () => {
    const below = { x1: -5675, y1: -19218, x2: 5675, y2: -14780 };
    expect(routeNewLink(below, { x1: -2767, y1: 500, x2: 8767, y2: 4500 }, false)).toEqual([
      [0, -16999],
      [0, -7140],
      [3000, -7140],
      [3000, 2500],
    ]);
  });
});
