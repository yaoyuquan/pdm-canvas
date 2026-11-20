/**
 * Validation for attribute edits. Errors block the edit; warnings are shown
 * but allowed (real models often contain e.g. Chinese codes).
 */
import { parseDataType, type EditableAttr } from '../pdm/changes';
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
  if (attr === 'Comment' || attr === 'DefaultValue') return null;
  if (attr === 'Mandatory') return validateMandatory(model, target, value);
  if (attr === 'DataType') return validateDataType(model, target, value);
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

/** Oracle 11g limits: VARCHAR2 4000 bytes, NUMBER precision 38. */
const ORACLE_MAX_VARCHAR2 = 4000;
const ORACLE_MAX_NUMBER_PRECISION = 38;

function validateMandatory(model: PdmModel, target: EditTarget, value: string): Issue | null {
  if (target.kind !== 'column' || value === '1') return null;
  const table = model.tables.find((t) => t.id === target.tableId);
  const pk = table?.keys.find((k) => k.id === table.primaryKeyId);
  if (pk?.columnIds.includes(target.columnId)) return { level: 'error', message: '主键字段必须非空' };
  return null;
}

function validateDataType(model: PdmModel, target: EditTarget, value: string): Issue | null {
  const v = value.trim();
  if (v === '') return { level: 'error', message: '数据类型不能为空' };
  if (v !== value) return { level: 'error', message: '首尾不能有空格' };
  if (!balancedParens(v)) return { level: 'error', message: '括号不匹配' };
  if (target.kind !== 'column') return null;

  if (isOracle(model)) {
    const { length } = parseDataType(v);
    const base = v.replace(/\s*\(.*$/, '').toUpperCase();
    if ((base === 'VARCHAR2' || base === 'NVARCHAR2') && length !== null && length > ORACLE_MAX_VARCHAR2) {
      return { level: 'warning', message: `${base} 长度超过 Oracle 11g 上限 ${ORACLE_MAX_VARCHAR2}` };
    }
    if (base === 'NUMBER' && length !== null && length > ORACLE_MAX_NUMBER_PRECISION) {
      return { level: 'warning', message: `NUMBER 精度超过 Oracle 11g 上限 ${ORACLE_MAX_NUMBER_PRECISION}` };
    }
  }

  const other = joinedColumns(model, target.columnId).find((c) => c.dataType.toUpperCase() !== v.toUpperCase());
  if (other) {
    return { level: 'warning', message: `与关联字段 ${other.label} 的类型 ${other.dataType} 不一致` };
  }
  return null;
}

function balancedParens(v: string): boolean {
  let depth = 0;
  for (const ch of v) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/** Columns on the other side of every FK join that involves the given column. */
function joinedColumns(model: PdmModel, columnId: string): Array<{ label: string; dataType: string }> {
  const byId = new Map(
    model.tables.flatMap((t) => t.columns.map((c) => [c.id, { label: `${t.code}.${c.code}`, dataType: c.dataType }])),
  );
  const out: Array<{ label: string; dataType: string }> = [];
  for (const r of model.references) {
    for (const j of r.joins) {
      const otherId =
        j.parentColumnId === columnId ? j.childColumnId : j.childColumnId === columnId ? j.parentColumnId : null;
      const other = otherId ? byId.get(otherId) : undefined;
      if (other) out.push(other);
    }
  }
  return out;
}
