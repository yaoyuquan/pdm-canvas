/**
 * Command layer: every model edit is a command with before/after values,
 * applied immutably. The history reducer provides undo/redo. Both the
 * property panel and (later) the canvas dispatch commands through here.
 */
import { ATTR_FIELD, type EditableAttr } from '../pdm/changes';
import type { PdmColumn, PdmModel, PdmTable } from '../pdm/types';

export type EditTarget = { kind: 'table'; tableId: string } | { kind: 'column'; tableId: string; columnId: string };

export interface SetAttrCommand {
  type: 'setAttr';
  target: EditTarget;
  attr: EditableAttr;
  before: string;
  after: string;
}

export type Command = SetAttrCommand;

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
  return findTarget(model, target)?.[ATTR_FIELD[attr]];
}

/** Returns a new model with one attribute changed; untouched parts keep their identity. */
export function setAttr(model: PdmModel, target: EditTarget, attr: EditableAttr, value: string): PdmModel {
  const field = ATTR_FIELD[attr];
  return {
    ...model,
    tables: model.tables.map((t) => {
      if (t.id !== target.tableId) return t;
      if (target.kind === 'table') return { ...t, [field]: value };
      return { ...t, columns: t.columns.map((c) => (c.id === target.columnId ? { ...c, [field]: value } : c)) };
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

const ATTR_LABEL: Record<EditableAttr, string> = { Name: '名称', Code: '代码', Comment: '注释' };

/** Human-readable description, e.g. for undo/redo tooltips. */
export function describeCommand(model: PdmModel, cmd: Command): string {
  const table = model.tables.find((t) => t.id === cmd.target.tableId);
  const column =
    cmd.target.kind === 'column'
      ? table?.columns.find((c) => c.id === (cmd.target as { columnId: string }).columnId)
      : undefined;
  const owner = column ? `${table?.code}.${column.code}` : (table?.code ?? '');
  return `修改 ${owner} 的${ATTR_LABEL[cmd.attr]}`;
}
