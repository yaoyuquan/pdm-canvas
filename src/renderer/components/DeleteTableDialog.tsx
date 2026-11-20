import { Button, Modal, Typography } from 'antd';
import type { PdmModel } from '../../pdm/types';

interface Props {
  model: PdmModel;
  /** Table to delete; the dialog is open while this is set. */
  tableId: string | null;
  /** Whether the table has a symbol in the current diagram ("仅删除图形" possible). */
  hasSymbol: boolean;
  onDeleteObject: () => void;
  onDeleteSymbol: () => void;
  onCancel: () => void;
}

/**
 * Confirms deleting a table, with PowerDesigner's two choices: delete the
 * object from the model (everywhere), or only remove its symbol from the
 * current diagram.
 */
export function DeleteTableDialog({ model, tableId, hasSymbol, onDeleteObject, onDeleteSymbol, onCancel }: Props) {
  const table = model.tables.find((t) => t.id === tableId);
  // What else goes when the object is deleted, so the user is not surprised.
  const refs = table
    ? model.references.filter((r) => r.parentTableId === table.id || r.childTableId === table.id).length
    : 0;

  return (
    <Modal
      title="删除表"
      open={!!table}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        hasSymbol && (
          <Button key="symbol" onClick={onDeleteSymbol}>
            仅删除图形
          </Button>
        ),
        <Button key="object" type="primary" danger onClick={onDeleteObject}>
          删除对象
        </Button>,
      ]}
    >
      {table && (
        <>
          <Typography.Paragraph>
            删除表 <span className="mono">{table.code}</span>
            {table.name !== table.code && `（${table.name}）`}？
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary">
            「删除对象」从模型中删除该表及其字段、键和索引，并删除所有关系图中的图形
            {refs > 0 && `，以及与之相连的 ${refs} 个关系`}。
            {hasSymbol && '「仅删除图形」只从当前关系图中移除，表仍保留在模型中。'}
            可以撤销。
          </Typography.Paragraph>
        </>
      )}
    </Modal>
  );
}
