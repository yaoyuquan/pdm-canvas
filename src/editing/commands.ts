/**
 * Command layer: every model edit is a command with before/after values,
 * applied immutably. The history reducer provides undo/redo. Both the
 * property panel and the canvas dispatch commands through here.
 */
import { readAttr, writeAttr, type EditableAttr } from '../pdm/changes';
import type { PdmColumn, PdmModel, PdmTable } from '../pdm/types';

export type EditTarget = { kind: 'table'; tableId: string } | { kind: 'column'; tableId: string; columnId: string };

export interface SetAttrCommand {
  type: 'setAttr';
  target: EditTarget;
  attr: EditableAttr;
  before: string;
  after: string;
}

/**
 * A structural edit (add/delete table or column, primary key, symbols),
 * stored as the model before and after. Models are immutable and share
 * unchanged parts, so keeping both is cheap; undo restores `before`.
 */
export interface ModelCommand {
  type: 'model';
  /** Shown in undo/redo tooltips, e.g. "新建表 Table_1". */
  label: string;
  before: PdmModel;
  after: PdmModel;
}

export type Command = SetAttrCommand | ModelCommand;

/** Wraps the result of a structural edit as a command, or null if nothing changed. */
export function modelCommand(label: string, before: PdmModel, after: PdmModel): ModelCommand | null {
  return before === after ? null : { type: 'model', label, before, after };
}

export interface History {
  model: PdmModel;
  past: Command[];
  future: Command[];
}

export type HistoryAction =
  | { type: 'reset'; model: PdmModel }
  | { type: 'exec'; command: Command }
  | { type: 'undo' }
  | { type: 'redo' };

const MAX_HISTORY = 200;

export function findTarget(model: PdmModel, target: EditTarget): PdmTable | PdmColumn | undefined {
  const table = model.tables.find((t) => t.id === target.tableId);
  return target.kind === 'table' ? table : table?.columns.find((c) => c.id === target.columnId);
}

export function getAttr(model: PdmModel, target: EditTarget, attr: EditableAttr): string | undefined {
  const obj = findTarget(model, target);
  if (!obj) return undefined;
  if (target.kind === 'table' && attr !== 'Name' && attr !== 'Code' && attr !== 'Comment') return undefined;
  return readAttr(obj, attr);
}

/** Returns a new model with one attribute changed; untouched parts keep their identity. */
export function setAttr(model: PdmModel, target: EditTarget, attr: EditableAttr, value: string): PdmModel {
  return {
    ...model,
    tables: model.tables.map((t) => {
      if (t.id !== target.tableId) return t;
      if (target.kind === 'table') return writeAttr(t, attr, value);
      return { ...t, columns: t.columns.map((c) => (c.id === target.columnId ? writeAttr(c, attr, value) : c)) };
    }),
  };
}

/** Builds a command for setting an attribute, or null when nothing would change. */
export function setAttrCommand(
  model: PdmModel,
  target: EditTarget,
  attr: EditableAttr,
  value: string,
): SetAttrCommand | null {
  const before = getAttr(model, target, attr);
  if (before === undefined || before === value) return null;
  return { type: 'setAttr', target, attr, before, after: value };
}

function apply(model: PdmModel, cmd: Command, dir: 'do' | 'undo'): PdmModel {
  // History is linear, so the current model is exactly the command's
  // `after` (when undoing) or `before` (when redoing).
  if (cmd.type === 'model') return dir === 'do' ? cmd.after : cmd.before;
  return setAttr(model, cmd.target, cmd.attr, dir === 'do' ? cmd.after : cmd.before);
}

export function historyReducer(state: History, action: HistoryAction): History {
  switch (action.type) {
    case 'reset':
      return { model: action.model, past: [], future: [] };
    case 'exec':
      return {
        model: apply(state.model, action.command, 'do'),
        past: [...state.past, action.command].slice(-MAX_HISTORY),
        future: [],
      };
    case 'undo': {
      const cmd = state.past[state.past.length - 1];
      if (!cmd) return state;
      return { model: apply(state.model, cmd, 'undo'), past: state.past.slice(0, -1), future: [cmd, ...state.future] };
    }
    case 'redo': {
      const cmd = state.future[0];
      if (!cmd) return state;
      return { model: apply(state.model, cmd, 'do'), past: [...state.past, cmd], future: state.future.slice(1) };
    }
  }
}

const ATTR_LABEL: Record<EditableAttr, string> = {
  Name: '名称',
  Code: '代码',
  Comment: '注释',
  DataType: '数据类型',
  DefaultValue: '默认值',
  Mandatory: '非空',
};

/** Human-readable description, e.g. for undo/redo tooltips. */
export function describeCommand(model: PdmModel, cmd: Command): string {
  if (cmd.type === 'model') return cmd.label;
  const table = model.tables.find((t) => t.id === cmd.target.tableId);
  const column =
    cmd.target.kind === 'column'
      ? table?.columns.find((c) => c.id === (cmd.target as { columnId: string }).columnId)
      : undefined;
  const owner = column ? `${table?.code}.${column.code}` : (table?.code ?? '');
  return `修改 ${owner} 的${ATTR_LABEL[cmd.attr]}`;
}
