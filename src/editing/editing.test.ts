import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffAttributes, parseDataType, readPdm, writeChanges, type EditableAttr } from '../pdm';
import { historyReducer, setAttrCommand, type EditTarget, type History } from './commands';
import { validateAttr } from './validate';

const FIXTURES = path.resolve(__dirname, '../../test-fixtures');
const src = fs.readFileSync(path.join(FIXTURES, 'synthetic/minimal.pdm'), 'utf8');
const doc = readPdm(src);
const base = doc.model;

const CUSTOMER: EditTarget = { kind: 'table', tableId: 'o7' };
const ORDER_ID: EditTarget = { kind: 'column', tableId: 'o8', columnId: 'o12' };
const CUSTOMER_NAME: EditTarget = { kind: 'column', tableId: 'o7', columnId: 'o10' };
const ORDER_CUSTOMER_ID: EditTarget = { kind: 'column', tableId: 'o8', columnId: 'o13' };
const CREATED_AT: EditTarget = { kind: 'column', tableId: 'o8', columnId: 'o14' };

function exec(h: History, target: EditTarget, attr: EditableAttr, value: string): History {
  const command = setAttrCommand(h.model, target, attr, value);
  if (!command) throw new Error('no-op command');
  return historyReducer(h, { type: 'exec', command });
}

describe('command history', () => {
  const start: History = { model: base, past: [], future: [] };

  it('applies, undoes, and redoes edits', () => {
    let h = exec(start, CUSTOMER, 'Comment', '新注释');
    h = exec(h, ORDER_ID, 'Name', '订单编号');
    expect(h.model.tables[0].comment).toBe('新注释');
    expect(h.model.tables[1].columns[0].name).toBe('订单编号');

    h = historyReducer(h, { type: 'undo' });
    expect(h.model.tables[1].columns[0].name).toBe('订单ID');
    h = historyReducer(h, { type: 'undo' });
    expect(h.model.tables[0].comment).toBe('客户主档');
    expect(diffAttributes(base, h.model)).toEqual([]);

    h = historyReducer(h, { type: 'redo' });
    expect(h.model.tables[0].comment).toBe('新注释');
    expect(h.future).toHaveLength(1);
  });

  it('clears redo after a new edit and ignores no-op edits', () => {
    let h = exec(start, CUSTOMER, 'Comment', 'A');
    h = historyReducer(h, { type: 'undo' });
    h = exec(h, CUSTOMER, 'Comment', 'B');
    expect(h.future).toEqual([]);
    expect(setAttrCommand(h.model, CUSTOMER, 'Comment', 'B')).toBeNull();
  });

  it('keeps identity of untouched tables', () => {
    const h = exec(start, CUSTOMER, 'Name', '顾客');
    expect(h.model.tables[1]).toBe(base.tables[1]);
    expect(h.model.diagrams).toBe(base.diagrams);
  });
});

describe('save path', () => {
  it('writes name, code, and comment changes and reads them back', () => {
    let h: History = { model: base, past: [], future: [] };
    h = exec(h, CUSTOMER, 'Code', 'CUST');
    h = exec(h, CUSTOMER, 'Name', '顾客');
    h = exec(h, ORDER_ID, 'Comment', '订单主键\n第二行');
    const changes = diffAttributes(base, h.model);
    expect(changes).toHaveLength(3);

    const out = writeChanges(doc, changes);
    expect(out).toContain('<a:Comment>订单主键\r\n第二行</a:Comment>');
    const again = readPdm(out).model;
    expect(again.tables[0]).toMatchObject({ code: 'CUST', name: '顾客' });
    expect(again.tables[1].columns[0].comment).toBe('订单主键\n第二行');
    // Re-reading the saved file yields exactly the edited model.
    expect(diffAttributes(h.model, again)).toEqual([]);
    expect(again.references).toEqual(base.references);
    expect(again.diagrams).toEqual(base.diagrams);
  });

  it('produces the original bytes when edits are undone', () => {
    let h: History = { model: base, past: [], future: [] };
    h = exec(h, CUSTOMER, 'Comment', 'x');
    h = historyReducer(h, { type: 'undo' });
    expect(writeChanges(doc, diffAttributes(base, h.model))).toBe(src);
  });

  it('refuses empty names and non-table objects', () => {
    expect(() => writeChanges(doc, [{ objectId: 'o7', attr: 'Name', value: ' ' }])).toThrow();
    expect(() => writeChanges(doc, [{ objectId: 'o20', attr: 'Comment', value: 'x' }])).toThrow();
  });
});

describe('validation', () => {
  it('rejects empty and duplicate codes', () => {
    expect(validateAttr(base, CUSTOMER, 'Code', '')?.level).toBe('error');
    expect(validateAttr(base, CUSTOMER, 'Code', 'sales_order')?.message).toContain('SALES_ORDER');
    expect(validateAttr(base, ORDER_ID, 'Code', 'CREATED_AT')?.level).toBe('error');
    expect(validateAttr(base, ORDER_ID, 'Code', ' ORDER_ID')?.level).toBe('error');
  });

  it('warns about Oracle length and unusual characters but allows them', () => {
    expect(validateAttr(base, CUSTOMER, 'Code', 'A'.repeat(31))?.level).toBe('warning');
    expect(validateAttr(base, CUSTOMER, 'Code', '客户表')?.level).toBe('warning');
    expect(validateAttr(base, CUSTOMER, 'Code', 'CUSTOMER_MAIN')).toBeNull();
  });

  it('accepts any comment and requires a name', () => {
    expect(validateAttr(base, CUSTOMER, 'Comment', '')).toBeNull();
    expect(validateAttr(base, CUSTOMER, 'Name', '')?.level).toBe('error');
  });
});

describe('column attributes', () => {
  const start: History = { model: base, past: [], future: [] };
  /** Text of the given object's element in `text` (offsets re-read from `text`). */
  const elementText = (text: string, id: string) => {
    const el = readPdm(text).byId.get(id)!;
    return text.slice(el.start, el.end);
  };
  /** Asserts that only the given object's element differs between src and out. */
  const onlyChanged = (out: string, id: string) => {
    const el = doc.byId.get(id)!;
    expect(out.slice(0, el.start)).toBe(src.slice(0, el.start));
    expect(out.slice(out.length - (src.length - el.end))).toBe(src.slice(el.end));
  };

  it('parses length and precision from data types', () => {
    expect(parseDataType('NUMBER(18,2)')).toEqual({ length: 18, precision: 2 });
    expect(parseDataType('VARCHAR2(20 char)')).toEqual({ length: 20, precision: null });
    expect(parseDataType('VARCHAR2(20 BYTE)')).toEqual({ length: 20, precision: null });
    expect(parseDataType('TIMESTAMP(6) WITH TIME ZONE')).toEqual({ length: 6, precision: null });
    expect(parseDataType('DATE')).toEqual({ length: null, precision: null });
  });

  it('writes data type with derived length and precision in PowerDesigner order', () => {
    const h = exec(start, CUSTOMER_NAME, 'DataType', 'NUMBER(18,2)');
    expect(h.model.tables[0].columns[1]).toMatchObject({ dataType: 'NUMBER(18,2)', length: 18, precision: 2 });
    const out = writeChanges(doc, diffAttributes(base, h.model));
    expect(elementText(out, 'o10')).toContain(
      '<a:DataType>NUMBER(18,2)</a:DataType>\r\n<a:Length>18</a:Length>\r\n<a:Precision>2</a:Precision>\r\n</o:Column>',
    );
    onlyChanged(out, 'o10');
    expect(readPdm(out).model.tables[0].columns[1]).toEqual(h.model.tables[0].columns[1]);
  });

  it('removes length when the type has none', () => {
    const h = exec(start, CUSTOMER_NAME, 'DataType', 'CLOB');
    const out = writeChanges(doc, diffAttributes(base, h.model));
    expect(elementText(out, 'o10')).toContain('<a:DataType>CLOB</a:DataType>\r\n</o:Column>');
    expect(readPdm(out).model.tables[0].columns[1]).toMatchObject({ length: null, precision: null });
  });

  it('inserts and removes Column.Mandatory', () => {
    let h = exec(start, CUSTOMER_NAME, 'Mandatory', '1');
    let out = writeChanges(doc, diffAttributes(base, h.model));
    expect(elementText(out, 'o10')).toContain(
      '<a:Length>100</a:Length>\r\n<a:Column.Mandatory>1</a:Column.Mandatory>\r\n</o:Column>',
    );
    onlyChanged(out, 'o10');
    expect(readPdm(out).model.tables[0].columns[1].mandatory).toBe(true);

    h = exec(start, CREATED_AT, 'Mandatory', '');
    out = writeChanges(doc, diffAttributes(base, h.model));
    expect(elementText(out, 'o14')).not.toContain('Column.Mandatory');
    expect(readPdm(out).model.tables[1].columns[2].mandatory).toBe(false);
  });

  it('inserts a default value after Comment and before DataType, and clears it', () => {
    let h = exec(start, CUSTOMER_NAME, 'DefaultValue', "'未知'");
    let out = writeChanges(doc, diffAttributes(base, h.model));
    expect(elementText(out, 'o10')).toContain(
      "</a:Comment>\r\n<a:DefaultValue>'未知'</a:DefaultValue>\r\n<a:DataType>",
    );
    expect(readPdm(out).model.tables[0].columns[1].defaultValue).toBe("'未知'");

    h = exec(start, CREATED_AT, 'DefaultValue', '');
    out = writeChanges(doc, diffAttributes(base, h.model));
    expect(elementText(out, 'o14')).not.toContain('DefaultValue');
  });

  it('combines several new elements in one column in order', () => {
    let h = exec(start, ORDER_CUSTOMER_ID, 'DataType', 'NUMBER(18,0)');
    h = exec(h, ORDER_CUSTOMER_ID, 'Mandatory', '1');
    h = exec(h, ORDER_CUSTOMER_ID, 'DefaultValue', '0');
    h = exec(h, ORDER_CUSTOMER_ID, 'Comment', '客户');
    const out = writeChanges(doc, diffAttributes(base, h.model).reverse());
    expect(elementText(out, 'o13')).toMatch(
      /<a:Comment>客户<\/a:Comment>\r\n<a:DefaultValue>0<\/a:DefaultValue>\r\n<a:DataType>NUMBER\(18,0\)<\/a:DataType>\r\n<a:Length>18<\/a:Length>\r\n<a:Precision>0<\/a:Precision>\r\n<a:Column.Mandatory>1<\/a:Column.Mandatory>\r\n<\/o:Column>/,
    );
    expect(diffAttributes(h.model, readPdm(out).model)).toEqual([]);
  });

  it('undoes back to the original bytes', () => {
    let h = exec(start, CUSTOMER_NAME, 'DataType', 'CLOB');
    h = exec(h, CUSTOMER_NAME, 'Mandatory', '1');
    h = historyReducer(historyReducer(h, { type: 'undo' }), { type: 'undo' });
    expect(diffAttributes(base, h.model)).toEqual([]);
    h = historyReducer(h, { type: 'redo' });
    expect(h.model.tables[0].columns[1].dataType).toBe('CLOB');
  });

  it('refuses column attributes on tables and empty data types', () => {
    expect(() => writeChanges(doc, [{ objectId: 'o7', attr: 'DataType', value: 'DATE' }])).toThrow();
    expect(() => writeChanges(doc, [{ objectId: 'o10', attr: 'DataType', value: ' ' }])).toThrow();
    expect(setAttrCommand(base, CUSTOMER, 'DataType', 'DATE')).toBeNull();
  });

  it('validates data types and mandatory', () => {
    expect(validateAttr(base, CUSTOMER_NAME, 'DataType', '')?.level).toBe('error');
    expect(validateAttr(base, CUSTOMER_NAME, 'DataType', 'NUMBER(18')?.level).toBe('error');
    expect(validateAttr(base, CUSTOMER_NAME, 'DataType', 'VARCHAR2(4001)')?.level).toBe('warning');
    expect(validateAttr(base, CUSTOMER_NAME, 'DataType', 'NUMBER(39)')?.level).toBe('warning');
    expect(validateAttr(base, CUSTOMER_NAME, 'DataType', 'VARCHAR2(200 char)')).toBeNull();
    expect(validateAttr(base, ORDER_CUSTOMER_ID, 'DataType', 'NUMBER(20)')?.message).toContain('CUSTOMER.CUSTOMER_ID');
    expect(validateAttr(base, ORDER_CUSTOMER_ID, 'DataType', 'number(18)')).toBeNull();
    expect(validateAttr(base, ORDER_ID, 'Mandatory', '')?.level).toBe('error');
    expect(validateAttr(base, CREATED_AT, 'Mandatory', '')).toBeNull();
  });
});

const PRIVATE_DIR = path.join(FIXTURES, 'private');
const privateFiles = fs.existsSync(PRIVATE_DIR)
  ? fs.readdirSync(PRIVATE_DIR).filter((f) => f.toLowerCase().endsWith('.pdm'))
  : [];

describe.skipIf(privateFiles.length === 0)('save path on private fixtures (local only)', () => {
  it.each(privateFiles)('%s: name/code/comment and column type edits survive a save and reload', (file) => {
    const text = fs.readFileSync(path.join(PRIVATE_DIR, file), 'utf8');
    const d = readPdm(text);
    const t = d.model.tables[0];
    const c = t.columns[t.columns.length - 1];
    const tt: EditTarget = { kind: 'table', tableId: t.id };
    const ct: EditTarget = { kind: 'column', tableId: t.id, columnId: c.id };

    let h: History = { model: d.model, past: [], future: [] };
    h = exec(h, tt, 'Comment', '往返测试：表注释');
    h = exec(h, tt, 'Name', `${t.name}_改`);
    h = exec(h, ct, 'Code', `${c.code}_X`);
    h = exec(h, ct, 'Comment', '往返测试：字段注释\n多行');
    h = exec(h, ct, 'DataType', 'NUMBER(12,4)');
    h = exec(h, ct, 'Mandatory', c.mandatory ? '' : '1');
    h = exec(h, ct, 'DefaultValue', c.defaultValue ? '' : '0');

    const out = writeChanges(d, diffAttributes(d.model, h.model));
    const again = readPdm(out).model;
    expect(diffAttributes(h.model, again)).toEqual([]);
    expect(again.references).toEqual(d.model.references);
    expect(again.diagrams).toEqual(d.model.diagrams);
    expect(again.tables.slice(1)).toEqual(d.model.tables.slice(1));

    // Everything outside the edited table element is byte-identical.
    const el = d.byId.get(t.id)!;
    expect(out.slice(0, el.start)).toBe(text.slice(0, el.start));
    expect(out.slice(out.length - (text.length - el.end))).toBe(text.slice(el.end));
  });
});
