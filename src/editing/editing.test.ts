import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffAttributes, readPdm, writeChanges } from '../pdm';
import { historyReducer, setAttrCommand, type EditTarget, type History } from './commands';
import { validateAttr } from './validate';

const FIXTURES = path.resolve(__dirname, '../../test-fixtures');
const src = fs.readFileSync(path.join(FIXTURES, 'synthetic/minimal.pdm'), 'utf8');
const doc = readPdm(src);
const base = doc.model;

const CUSTOMER: EditTarget = { kind: 'table', tableId: 'o7' };
const ORDER_ID: EditTarget = { kind: 'column', tableId: 'o8', columnId: 'o12' };

function exec(h: History, target: EditTarget, attr: 'Name' | 'Code' | 'Comment', value: string): History {
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

const PRIVATE_DIR = path.join(FIXTURES, 'private');
const privateFiles = fs.existsSync(PRIVATE_DIR)
  ? fs.readdirSync(PRIVATE_DIR).filter((f) => f.toLowerCase().endsWith('.pdm'))
  : [];

describe.skipIf(privateFiles.length === 0)('save path on private fixtures (local only)', () => {
  it.each(privateFiles)('%s: name/code/comment edits survive a save and reload', (file) => {
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
