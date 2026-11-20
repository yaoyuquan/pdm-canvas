import { useEffect, useState } from 'react';
import { Button, Checkbox, Input, Space, Tooltip } from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  InsertRowAboveOutlined,
  PlusOutlined,
  RightOutlined,
} from '@ant-design/icons';
import type { EditableAttr } from '../../pdm/changes';
import type { PdmModel, PdmTable } from '../../pdm/types';
import type { EditTarget } from '../../editing/commands';
import { validateAttr } from '../../editing/validate';

/** Column operations the grid can trigger; App turns them into commands. */
export interface ColumnActions {
  /** Adds a column at `index` (default: at the end); returns its Id. */
  add: (tableId: string, index?: number) => string | null;
  remove: (tableId: string, columnId: string) => void;
  move: (tableId: string, columnId: string, delta: number) => void;
  setPrimary: (tableId: string, columnId: string, primary: boolean) => void;
}

interface Props {
  model: PdmModel;
  table: PdmTable;
  /** Row highlighted in the grid (target of insert/delete/move). */
  currentId: string | null;
  onCurrent: (columnId: string) => void;
  /** Opens the full column properties (comment, default value, …). */
  onOpen: (columnId: string) => void;
  onEdit: (target: EditTarget, attr: EditableAttr, value: string) => void;
  actions: ColumnActions;
}

/**
 * The table's column list as an editable grid, like the Columns tab of
 * PowerDesigner's table properties: Name, Code, Data Type, P (primary key),
 * M (mandatory), with add / insert / delete / move up / move down.
 */
export function ColumnGrid({ model, table: t, currentId, onCurrent, onOpen, onEdit, actions }: Props) {
  const pk = new Set(t.keys.find((k) => k.id === t.primaryKeyId)?.columnIds ?? []);
  const index = t.columns.findIndex((c) => c.id === currentId);
  const current = index >= 0 ? t.columns[index] : null;

  return (
    <div className="column-grid">
      {/* Toolbar: operations act on the highlighted row, like in PowerDesigner. */}
      <Space.Compact size="small" className="column-grid-tools">
        <Tooltip title="添加字段（末尾）">
          <Button icon={<PlusOutlined />} onClick={() => actions.add(t.id)} />
        </Tooltip>
        <Tooltip title="在当前行之前插入字段">
          <Button icon={<InsertRowAboveOutlined />} disabled={!current} onClick={() => actions.add(t.id, index)} />
        </Tooltip>
        <Tooltip title="删除当前字段（Delete）">
          <Button
            icon={<DeleteOutlined />}
            danger
            disabled={!current}
            onClick={() => current && actions.remove(t.id, current.id)}
          />
        </Tooltip>
        <Tooltip title="上移">
          <Button
            icon={<ArrowUpOutlined />}
            disabled={!current || index === 0}
            onClick={() => current && actions.move(t.id, current.id, -1)}
          />
        </Tooltip>
        <Tooltip title="下移">
          <Button
            icon={<ArrowDownOutlined />}
            disabled={!current || index === t.columns.length - 1}
            onClick={() => current && actions.move(t.id, current.id, 1)}
          />
        </Tooltip>
      </Space.Compact>

      <table className="grid">
        {/* Fixed column widths: text cells share the space, checkboxes stay narrow. */}
        <colgroup>
          <col />
          <col />
          <col />
          <col className="col-check" />
          <col className="col-check" />
          <col className="col-check" />
        </colgroup>
        <thead>
          <tr>
            <th>名称</th>
            <th>代码</th>
            <th>数据类型</th>
            <th title="主键（Primary）">P</th>
            <th title="非空（Mandatory）">M</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {t.columns.map((c) => {
            const target: EditTarget = { kind: 'column', tableId: t.id, columnId: c.id };
            // Shared props for the three text cells of this row.
            const cell = (attr: EditableAttr, value: string, mono = false) => (
              <GridCell
                value={value}
                mono={mono}
                validate={(v) => validateAttr(model, target, attr, v)}
                onFocus={() => onCurrent(c.id)}
                onCommit={(v) => onEdit(target, attr, v)}
              />
            );
            const isPk = pk.has(c.id);
            return (
              <tr key={c.id} className={c.id === currentId ? 'current' : undefined} onClick={() => onCurrent(c.id)}>
                <td>{cell('Name', c.name)}</td>
                <td>{cell('Code', c.code, true)}</td>
                <td>{cell('DataType', c.dataType, true)}</td>
                <td className="grid-check">
                  <Checkbox checked={isPk} onChange={(e) => actions.setPrimary(t.id, c.id, e.target.checked)} />
                </td>
                <td className="grid-check">
                  {/* A primary key column must stay mandatory. */}
                  <Checkbox
                    checked={c.mandatory}
                    disabled={isPk && c.mandatory}
                    onChange={(e) => onEdit(target, 'Mandatory', e.target.checked ? '1' : '')}
                  />
                </td>
                <td className="grid-check">
                  <Tooltip title="字段属性">
                    <Button type="text" size="small" icon={<RightOutlined />} onClick={() => onOpen(c.id)} />
                  </Tooltip>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {t.columns.length === 0 && <div className="grid-empty">没有字段，点击 + 添加</div>}
    </div>
  );
}

/**
 * Borderless text input for one grid cell. Commits on blur or Enter, reverts
 * on Escape; an invalid value is reverted and its message shown as a tooltip.
 */
function GridCell(props: {
  value: string;
  mono: boolean;
  validate: (v: string) => { level: 'error' | 'warning'; message: string } | null;
  onFocus: () => void;
  onCommit: (v: string) => void;
}) {
  const { value, mono, validate, onFocus, onCommit } = props;
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);

  // Undo/redo or another table replaces the draft.
  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [value]);

  // The error tooltip is a hint, not a blocker: hide it after a few seconds.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 3000);
    return () => clearTimeout(timer);
  }, [error]);

  const commit = () => {
    if (draft === value) return;
    const issue = validate(draft);
    if (issue?.level === 'error') {
      // Keep the model valid: show why, then fall back to the stored value.
      setError(issue.message);
      setDraft(value);
      return;
    }
    setError(null);
    onCommit(draft);
  };

  return (
    <Tooltip title={error} open={!!error} color="red">
      <Input
        size="small"
        variant="borderless"
        className={mono ? 'mono' : undefined}
        value={draft}
        status={error ? 'error' : undefined}
        onFocus={onFocus}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') {
            setDraft(value);
            setError(null);
            const el = e.currentTarget;
            // Let the reset render before blur, so blur doesn't commit the old draft.
            setTimeout(() => el.blur(), 0);
          }
        }}
      />
    </Tooltip>
  );
}
