import { useMemo, useState } from 'react';
import { Input, Tree, type TreeDataNode } from 'antd';
import { KeyOutlined, LinkOutlined, SearchOutlined, TableOutlined } from '@ant-design/icons';
import type { PdmModel, PdmTable } from '../../pdm/types';
import type { Selection } from '../selection';

interface Props {
  model: PdmModel;
  selection: Selection;
  onSelect: (sel: Selection) => void;
}

function fkColumnIds(model: PdmModel): Set<string> {
  const ids = new Set<string>();
  for (const r of model.references) for (const j of r.joins) if (j.childColumnId) ids.add(j.childColumnId);
  return ids;
}

function pkColumnIds(t: PdmTable): Set<string> {
  return new Set(t.keys.find((k) => k.id === t.primaryKeyId)?.columnIds ?? []);
}

export function ModelTree({ model, selection, onSelect }: Props) {
  const [query, setQuery] = useState('');

  const treeData = useMemo<TreeDataNode[]>(() => {
    const q = query.trim().toLowerCase();
    const hit = (...s: string[]) => !q || s.some((x) => x.toLowerCase().includes(q));
    const fks = fkColumnIds(model);

    const tables = model.tables
      .filter((t) => hit(t.code, t.name) || t.columns.some((c) => hit(c.code, c.name)))
      .sort((a, b) => a.code.localeCompare(b.code))
      .map<TreeDataNode>((t) => {
        const pks = pkColumnIds(t);
        return {
          key: `t:${t.id}`,
          icon: <TableOutlined />,
          title: (
            <span className="tree-item">
              <span className="mono">{t.code}</span>
              {t.name && t.name !== t.code && <span className="tree-sub">{t.name}</span>}
            </span>
          ),
          children: t.columns.map((c) => ({
            key: `c:${t.id}:${c.id}`,
            isLeaf: true,
            icon: pks.has(c.id) ? (
              <KeyOutlined className="ic-pk" />
            ) : fks.has(c.id) ? (
              <LinkOutlined className="ic-fk" />
            ) : (
              <span className="ic-blank" />
            ),
            title: (
              <span className="tree-item">
                <span className="mono">{c.code}</span>
                <span className="tree-sub">{c.dataType}</span>
              </span>
            ),
          })),
        };
      });

    const groups: TreeDataNode[] = [
      { key: 'g:tables', title: `表 (${tables.length})`, selectable: false, children: tables },
    ];
    if (model.views.length) {
      groups.push({
        key: 'g:views',
        title: `视图 (${model.views.length})`,
        selectable: false,
        children: model.views.map((v) => ({ key: `v:${v.id}`, title: v.code, isLeaf: true })),
      });
    }
    if (model.sequences.length) {
      groups.push({
        key: 'g:seqs',
        title: `序列 (${model.sequences.length})`,
        selectable: false,
        children: model.sequences.map((s) => ({ key: `s:${s.id}`, title: s.code, isLeaf: true })),
      });
    }
    return groups;
  }, [model, query]);

  const selectedKey = !selection
    ? []
    : selection.type === 'table'
      ? [`t:${selection.tableId}`]
      : selection.type === 'column'
        ? [`c:${selection.tableId}:${selection.columnId}`]
        : [];

  return (
    <div className="model-tree">
      <Input
        allowClear
        size="small"
        prefix={<SearchOutlined />}
        placeholder="搜索表名、中文名、字段"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <Tree
        showIcon
        blockNode
        defaultExpandedKeys={['g:tables']}
        selectedKeys={selectedKey}
        treeData={treeData}
        onSelect={(keys) => {
          const k = String(keys[0] ?? '');
          if (k.startsWith('t:')) onSelect({ type: 'table', tableId: k.slice(2) });
          else if (k.startsWith('c:')) {
            const [, tableId, columnId] = k.split(':');
            onSelect({ type: 'column', tableId, columnId });
          }
        }}
      />
    </div>
  );
}
