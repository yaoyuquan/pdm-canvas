import { useState } from 'react';
import { Descriptions, Switch, Tooltip, Typography } from 'antd';
import type { EditableAttr } from '../../pdm/changes';
import type { PdmColumn, PdmModel } from '../../pdm/types';
import type { EditTarget } from '../../editing/commands';
import { validateAttr } from '../../editing/validate';
import type { Selection } from '../selection';
import { EditableField } from './EditableField';
import { ColumnGrid, type ColumnActions } from './ColumnGrid';

interface Props {
  model: PdmModel;
  /** Decides what the panel shows: model, table, column, or reference. */
  selection: Selection;
  /** Navigates, e.g. from the column list to a column or back to its table. */
  onSelect: (sel: Selection) => void;
  /** Commits an attribute edit; becomes an undoable command in App. */
  onEdit: (target: EditTarget, attr: EditableAttr, value: string) => void;
  /** Structural column edits from the column grid. */
  columnActions: ColumnActions;
}

/** Name / Code / Comment inputs for a table or column. */
function NameCodeComment(props: {
  model: PdmModel;
  target: EditTarget;
  values: { name: string; code: string; comment: string };
  onEdit: Props['onEdit'];
}) {
  const { model, target, values, onEdit } = props;
  // Shared validate/commit wiring for one attribute of the target.
  const field = (attr: EditableAttr) => ({
    validate: (v: string) => validateAttr(model, target, attr, v),
    onCommit: (v: string) => onEdit(target, attr, v),
  });
  return (
    <div className="fields">
      <EditableField label="名称" value={values.name} {...field('Name')} />
      <EditableField label="代码" value={values.code} mono {...field('Code')} />
      <EditableField label="注释" value={values.comment} multiline placeholder="无注释" {...field('Comment')} />
    </div>
  );
}

/** Data type, default value, and mandatory flag of a column. */
function ColumnTypeFields(props: {
  model: PdmModel;
  target: EditTarget;
  column: PdmColumn;
  isPk: boolean;
  onEdit: Props['onEdit'];
}) {
  const { model, target, column: c, isPk, onEdit } = props;
  // Shared validate/commit wiring for one attribute of the target.
  const field = (attr: EditableAttr) => ({
    validate: (v: string) => validateAttr(model, target, attr, v),
    onCommit: (v: string) => onEdit(target, attr, v),
  });
  return (
    <div className="fields">
      <EditableField label="数据类型" value={c.dataType} mono {...field('DataType')} />
      <EditableField label="默认值" value={c.defaultValue} mono placeholder="无默认值" {...field('DefaultValue')} />
      <div className="field field-inline">
        <label className="field-label">非空</label>
        {/* A primary key column must stay mandatory, so the switch is locked. */}
        <Tooltip title={isPk ? '主键字段必须非空' : undefined}>
          <Switch
            checkedChildren="是"
            unCheckedChildren="否"
            checked={c.mandatory}
            disabled={isPk && c.mandatory}
            onChange={(checked) => onEdit(target, 'Mandatory', checked ? '1' : '')}
          />
        </Tooltip>
      </div>
      {/* Read-only: length and precision are derived from the data type. */}
      <Descriptions size="small" column={2} bordered>
        <Descriptions.Item label="长度">{c.length ?? <Dash />}</Descriptions.Item>
        <Descriptions.Item label="精度">{c.precision ?? <Dash />}</Descriptions.Item>
        <Descriptions.Item label="主键" span={2}>
          {isPk ? '是' : '否'}
        </Descriptions.Item>
      </Descriptions>
    </div>
  );
}

/** Inline text in the monospace font (codes, data types). */
const Mono = ({ children }: { children: React.ReactNode }) => <span className="mono">{children}</span>;
/** Placeholder for an empty value. */
const Dash = () => <Typography.Text type="secondary">—</Typography.Text>;

/**
 * Right-hand panel with the properties of the current selection. Tables and
 * columns are editable; references and the model are read-only for now.
 */
export function PropertyPanel({ model, selection, onSelect, onEdit, columnActions }: Props) {
  // Highlighted row of the column grid; insert/delete/move act on it.
  const [currentColumn, setCurrentColumn] = useState<string | null>(null);

  // Reference (foreign key): read-only summary and its column mappings.
  if (selection?.type === 'reference') {
    const r = model.references.find((x) => x.id === selection.referenceId);
    if (!r) return null;
    // "TABLE.COLUMN" labels for every column, for the join list.
    const cols = new Map(model.tables.flatMap((t) => t.columns.map((c) => [c.id, `${t.code}.${c.code}`] as const)));
    const tableCode = (id: string) => model.tables.find((t) => t.id === id)?.code ?? id;
    return (
      <Section title="关系">
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="名称">{r.name}</Descriptions.Item>
          <Descriptions.Item label="代码">
            <Mono>{r.code}</Mono>
          </Descriptions.Item>
          <Descriptions.Item label="父表">
            <Mono>{tableCode(r.parentTableId)}</Mono>
          </Descriptions.Item>
          <Descriptions.Item label="子表">
            <Mono>{tableCode(r.childTableId)}</Mono>
          </Descriptions.Item>
          <Descriptions.Item label="基数">{r.cardinality || <Dash />}</Descriptions.Item>
        </Descriptions>
        <h4 className="prop-subtitle">字段映射</h4>
        {r.joins.map((j) => (
          <div key={j.id} className="mono join-row">
            {cols.get(j.parentColumnId ?? '') ?? '?'} → {cols.get(j.childColumnId ?? '') ?? '?'}
          </div>
        ))}
      </Section>
    );
  }

  if (selection) {
    const t = model.tables.find((x) => x.id === selection.tableId);
    // The selected object may have just been deleted (e.g. by undo).
    if (!t) return null;
    const pk = new Set(t.keys.find((k) => k.id === t.primaryKeyId)?.columnIds ?? []);

    // Column: editable attributes, with a breadcrumb back to its table.
    if (selection.type === 'column') {
      const c = t.columns.find((x) => x.id === selection.columnId);
      if (!c) return null;
      return (
        <Section title="字段" back={() => onSelect({ type: 'table', tableId: t.id })} backLabel={t.code}>
          {/* key resets the inputs' drafts when another column is selected. */}
          <NameCodeComment
            key={c.id}
            model={model}
            target={{ kind: 'column', tableId: t.id, columnId: c.id }}
            values={c}
            onEdit={onEdit}
          />
          <ColumnTypeFields
            key={`type-${c.id}`}
            model={model}
            target={{ kind: 'column', tableId: t.id, columnId: c.id }}
            column={c}
            isPk={pk.has(c.id)}
            onEdit={onEdit}
          />
        </Section>
      );
    }

    // Table: editable name/code/comment and a clickable column list.
    return (
      <Section title="表">
        <NameCodeComment
          key={t.id}
          model={model}
          target={{ kind: 'table', tableId: t.id }}
          values={t}
          onEdit={onEdit}
        />
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="所有者">
            {model.users.find((u) => u.id === t.ownerId)?.code ?? <Dash />}
          </Descriptions.Item>
        </Descriptions>
        <h4 className="prop-subtitle">字段（{t.columns.length}）</h4>
        {/* Editable column list, like PowerDesigner's Columns tab. */}
        <ColumnGrid
          model={model}
          table={t}
          currentId={currentColumn}
          onCurrent={setCurrentColumn}
          onOpen={(columnId) => onSelect({ type: 'column', tableId: t.id, columnId })}
          onEdit={onEdit}
          actions={{
            ...columnActions,
            // A new column becomes the current row, ready for the next insert.
            add: (tableId, index) => {
              const id = columnActions.add(tableId, index);
              if (id) setCurrentColumn(id);
              return id;
            },
          }}
        />
      </Section>
    );
  }

  // Nothing selected: show the model's own properties.
  return (
    <Section title="模型">
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="名称">{model.name}</Descriptions.Item>
        <Descriptions.Item label="代码">
          <Mono>{model.code}</Mono>
        </Descriptions.Item>
        <Descriptions.Item label="目标数据库">{model.target}</Descriptions.Item>
        <Descriptions.Item label="PowerDesigner">{model.pdVersion}</Descriptions.Item>
        <Descriptions.Item label="注释">{model.comment || <Dash />}</Descriptions.Item>
      </Descriptions>
    </Section>
  );
}

/** Panel section with a title and an optional breadcrumb link back. */
function Section(props: { title: string; back?: () => void; backLabel?: string; children: React.ReactNode }) {
  return (
    <section className="prop-section">
      <h3 className="prop-title">
        {props.back && (
          <Typography.Link className="prop-back" onClick={props.back}>
            {props.backLabel} /
          </Typography.Link>
        )}
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}
