import { Descriptions, Table, Tag, Typography } from 'antd';
import type { EditableAttr } from '../../pdm/changes';
import type { PdmModel } from '../../pdm/types';
import type { EditTarget } from '../../editing/commands';
import { validateAttr } from '../../editing/validate';
import type { Selection } from '../selection';
import { EditableField } from './EditableField';

interface Props {
  model: PdmModel;
  selection: Selection;
  onSelect: (sel: Selection) => void;
  onEdit: (target: EditTarget, attr: EditableAttr, value: string) => void;
}

/** Name / Code / Comment inputs for a table or column. */
function NameCodeComment(props: {
  model: PdmModel;
  target: EditTarget;
  values: { name: string; code: string; comment: string };
  onEdit: Props['onEdit'];
}) {
  const { model, target, values, onEdit } = props;
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

const Mono = ({ children }: { children: React.ReactNode }) => <span className="mono">{children}</span>;
const Dash = () => <Typography.Text type="secondary">—</Typography.Text>;

export function PropertyPanel({ model, selection, onSelect, onEdit }: Props) {
  if (selection?.type === 'reference') {
    const r = model.references.find((x) => x.id === selection.referenceId);
    if (!r) return null;
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
    if (!t) return null;
    const pk = new Set(t.keys.find((k) => k.id === t.primaryKeyId)?.columnIds ?? []);

    if (selection.type === 'column') {
      const c = t.columns.find((x) => x.id === selection.columnId);
      if (!c) return null;
      return (
        <Section title="字段" back={() => onSelect({ type: 'table', tableId: t.id })} backLabel={t.code}>
          <NameCodeComment
            key={c.id}
            model={model}
            target={{ kind: 'column', tableId: t.id, columnId: c.id }}
            values={c}
            onEdit={onEdit}
          />
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="数据类型">
              <Mono>{c.dataType || '—'}</Mono>
            </Descriptions.Item>
            <Descriptions.Item label="非空">{c.mandatory ? '是' : '否'}</Descriptions.Item>
            <Descriptions.Item label="主键">{pk.has(c.id) ? '是' : '否'}</Descriptions.Item>
            <Descriptions.Item label="默认值">
              {c.defaultValue ? <Mono>{c.defaultValue}</Mono> : <Dash />}
            </Descriptions.Item>
          </Descriptions>
        </Section>
      );
    }

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
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={t.columns}
          onRow={(c) => ({ onClick: () => onSelect({ type: 'column', tableId: t.id, columnId: c.id }) })}
          rowClassName="clickable-row"
          columns={[
            {
              title: '代码',
              dataIndex: 'code',
              render: (v: string, c) => (
                <Mono>
                  {pk.has(c.id) ? (
                    <Tag color="gold" className="pk-tag">
                      PK
                    </Tag>
                  ) : null}
                  {v}
                </Mono>
              ),
            },
            { title: '类型', dataIndex: 'dataType', render: (v: string) => <Mono>{v}</Mono> },
            { title: '名称', dataIndex: 'name', ellipsis: true },
          ]}
        />
      </Section>
    );
  }

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
