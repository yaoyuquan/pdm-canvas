import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEdits, PdmFormatError, readPdm, setAttribute } from './index';
import { parseXml, XmlParseError } from './xml';

const FIXTURES = path.resolve(__dirname, '../../test-fixtures');
const SYNTHETIC = path.join(FIXTURES, 'synthetic/minimal.pdm');
const PRIVATE_DIR = path.join(FIXTURES, 'private');
const privateFiles = fs.existsSync(PRIVATE_DIR)
  ? fs.readdirSync(PRIVATE_DIR).filter((f) => f.toLowerCase().endsWith('.pdm'))
  : [];

const load = (file: string) => fs.readFileSync(file, 'utf8');

describe('xml scanner', () => {
  it('tracks offsets of nested and self-closing elements', () => {
    const src = '<a x="1"><b>t&amp;</b><c/></a>';
    const { root } = parseXml(src);
    expect(root.name).toBe('a');
    expect(root.attrs).toEqual({ x: '1' });
    const [b, c] = root.children;
    expect(src.slice(b.start, b.end)).toBe('<b>t&amp;</b>');
    expect(src.slice(b.openEnd, b.closeStart)).toBe('t&amp;');
    expect(c.selfClosing).toBe(true);
    expect(src.slice(c.start, c.end)).toBe('<c/>');
  });

  it('rejects mismatched tags', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(XmlParseError);
  });
});

describe('synthetic fixture', () => {
  const src = load(SYNTHETIC);
  const doc = readPdm(src);
  const m = doc.model;

  it('reads model header and objects', () => {
    expect(m.target).toBe('ORACLE Version 11g');
    expect(m.pdVersion).toBe('16.7.5.6978');
    expect(m.code).toBe('ORDER_SAMPLE');
    expect(m.comment).toBe('合成测试模型，"仅用于"单元测试 & CI');
    expect(m.tables.map((t) => t.code)).toEqual(['CUSTOMER', 'SALES_ORDER']);
  });

  it('reads columns, keys, and indexes', () => {
    const order = m.tables[1];
    expect(order.columns.map((c) => [c.code, c.dataType, c.mandatory])).toEqual([
      ['ORDER_ID', 'NUMBER(18)', true],
      ['CUSTOMER_ID', 'NUMBER(18)', false],
      ['CREATED_AT', 'TIMESTAMP', true],
    ]);
    expect(order.columns[2].defaultValue).toBe('SYSTIMESTAMP');
    expect(order.primaryKeyId).toBe('o15');
    expect(order.keys[0].columnIds).toEqual(['o12']);
    expect(order.indexes[0].columnIds).toEqual(['o13']);
    expect(m.tables[0].columns[1].comment).toBe('姓名 <实名>');
  });

  it('reads references and diagram symbols', () => {
    const ref = m.references[0];
    expect(ref).toMatchObject({ parentTableId: 'o7', childTableId: 'o8', parentKeyId: 'o11' });
    expect(ref.joins).toEqual([{ id: 'o21', parentColumnId: 'o9', childColumnId: 'o13' }]);
    const dg = m.diagrams[0];
    expect(dg.tableSymbols.map((s) => s.tableId)).toEqual(['o7', 'o8']);
    expect(dg.tableSymbols[0].rect).toEqual({ x1: -15000, y1: -5000, x2: -1000, y2: 6000 });
    expect(dg.referenceSymbols[0]).toMatchObject({
      referenceId: 'o20',
      sourceSymbolId: 'o6',
      destinationSymbolId: 'o5',
    });
  });

  it('round-trips byte-identically with no edits', () => {
    expect(applyEdits(src, [])).toBe(src);
  });

  it('replaces an existing comment, touching nothing else', () => {
    const out = applyEdits(src, setAttribute(doc, 'o10', 'Comment', '新注释 "A&B"'));
    expect(out).toContain('<a:Comment>新注释 &quot;A&amp;B&quot;</a:Comment>');
    expectOnlyObjectChanged(src, out, doc, 'o10');
    expect(readPdm(out).model.tables[0].columns[1].comment).toBe('新注释 "A&B"');
  });

  it('inserts a missing comment after Modifier using CRLF', () => {
    const out = applyEdits(src, setAttribute(doc, 'o12', 'Comment', '订单主键'));
    expect(out).toContain(
      '<a:Modifier>tester</a:Modifier>\r\n<a:Comment>订单主键</a:Comment>\r\n<a:DataType>NUMBER(18)</a:DataType>',
    );
    expectOnlyObjectChanged(src, out, doc, 'o12');
    expect(readPdm(out).model.tables[1].columns[0].comment).toBe('订单主键');
  });

  it('removes a comment when set to empty', () => {
    const out = applyEdits(src, setAttribute(doc, 'o10', 'Comment', ''));
    expect(out).toContain('<a:Modifier>tester</a:Modifier>\r\n<a:DataType>VARCHAR2(100)</a:DataType>');
    expect(readPdm(out).model.tables[0].columns[1].comment).toBe('');
  });

  it('rejects binary and non-PDM files', () => {
    expect(() => readPdm('\u0000\u0001binary')).toThrow(PdmFormatError);
    expect(() => readPdm('<?xml version="1.0"?><root/>')).toThrow(PdmFormatError);
  });
});

describe.skipIf(privateFiles.length === 0)('private fixtures (local only)', () => {
  it.each(privateFiles)('%s: parses, resolves references, round-trips', (file) => {
    const src = load(path.join(PRIVATE_DIR, file));
    const doc = readPdm(src);
    const m = doc.model;
    expect(m.target).toMatch(/ORACLE/i);
    expect(m.tables.length).toBeGreaterThan(0);

    const columnIds = new Set(m.tables.flatMap((t) => t.columns.map((c) => c.id)));
    const tableIds = new Set(m.tables.map((t) => t.id));
    for (const t of m.tables) {
      for (const k of t.keys) k.columnIds.forEach((id) => expect(columnIds).toContain(id));
    }
    for (const r of m.references) {
      expect(tableIds).toContain(r.parentTableId);
      expect(tableIds).toContain(r.childTableId);
      for (const j of r.joins) {
        expect(columnIds).toContain(j.parentColumnId);
        expect(columnIds).toContain(j.childColumnId);
      }
    }
    for (const d of m.diagrams) {
      for (const s of d.tableSymbols) {
        expect(doc.byId.has(s.tableId)).toBe(true);
        expect(s.rect).not.toBeNull();
      }
    }

    expect(Buffer.from(applyEdits(src, []), 'utf8').equals(fs.readFileSync(path.join(PRIVATE_DIR, file)))).toBe(true);

    const col = m.tables[0].columns[0];
    const out = applyEdits(src, setAttribute(doc, col.id, 'Comment', '往返测试注释'));
    expectOnlyObjectChanged(src, out, doc, col.id);
    const again = readPdm(out).model;
    expect(again.tables[0].columns[0].comment).toBe('往返测试注释');
    expect(again.tables.length).toBe(m.tables.length);
    expect(again.references.length).toBe(m.references.length);
  });
});

/** Asserts that `out` differs from `src` only inside the given object's element. */
function expectOnlyObjectChanged(src: string, out: string, doc: ReturnType<typeof readPdm>, id: string) {
  const el = doc.byId.get(id)!;
  const tail = src.length - el.end;
  expect(out.slice(0, el.start)).toBe(src.slice(0, el.start));
  expect(out.slice(out.length - tail)).toBe(src.slice(el.end));
}
