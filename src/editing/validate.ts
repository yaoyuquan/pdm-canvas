/**
 * Validation for attribute edits. Errors block the edit; warnings are shown
 * but allowed (real models often contain e.g. Chinese codes).
 */
import type { EditableAttr } from '../pdm/changes';
import type { PdmModel } from '../pdm/types';
import type { EditTarget } from './commands';

export interface Issue {
  level: 'error' | 'warning';
  message: string;
}

/** Oracle 11g limits identifiers to 30 bytes. */
const ORACLE_MAX_IDENTIFIER_BYTES = 30;
const PLAIN_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_$#]*$/;

export function isOracle(model: PdmModel): boolean {
  return /oracle/i.test(model.target);
}

export function validateAttr(model: PdmModel, target: EditTarget, attr: EditableAttr, value: string): Issue | null {
  if (attr === 'Comment') return null;
  const v = value.trim();
  if (v === '') return { level: 'error', message: attr === 'Name' ? '名称不能为空' : '代码不能为空' };
  if (v !== value) return { level: 'error', message: '首尾不能有空格' };
  if (attr === 'Name') return null;

  const table = model.tables.find((t) => t.id === target.tableId);
  if (!table) return null;
  const same = (code: string) => code.toUpperCase() === v.toUpperCase();

  if (target.kind === 'table') {
    const dup = model.tables.find((t) => t.id !== table.id && t.ownerId === table.ownerId && same(t.code));
    if (dup) return { level: 'error', message: `与表 ${dup.code} 的代码重复` };
  } else {
    const dup = table.columns.find((c) => c.id !== target.columnId && same(c.code));
    if (dup) return { level: 'error', message: `与字段 ${dup.code} 的代码重复` };
  }

  if (isOracle(model)) {
    const bytes = new TextEncoder().encode(v).length;
    if (bytes > ORACLE_MAX_IDENTIFIER_BYTES) {
      return {
        level: 'warning',
        message: `超过 Oracle 11g 标识符 30 字节限制（当前 ${bytes} 字节），生成 DDL 时会失败`,
      };
    }
  }
  if (!PLAIN_IDENTIFIER.test(v)) {
    return { level: 'warning', message: '包含非常规字符，生成 DDL 时需要加引号' };
  }
  return null;
}
