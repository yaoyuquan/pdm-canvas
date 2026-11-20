import { useEffect, useState } from 'react';
import { Modal, Radio, Space, Typography } from 'antd';
import { DBMS_OPTIONS, type DbmsKind } from '../../pdm/template';

interface Props {
  open: boolean;
  /** Called with the chosen database when the user confirms. */
  onCreate: (dbms: DbmsKind) => void;
  onCancel: () => void;
}

/**
 * Asks for the target database before creating a new model. The choice is
 * fixed once created: the DBMS decides which template (and data types) apply.
 */
export function NewModelDialog({ open, onCreate, onCancel }: Props) {
  const [dbms, setDbms] = useState<DbmsKind>(DBMS_OPTIONS[0].kind);

  // Start from the default every time the dialog opens, not the last choice.
  useEffect(() => {
    if (open) setDbms(DBMS_OPTIONS[0].kind);
  }, [open]);

  return (
    <Modal
      title="新建物理数据模型"
      open={open}
      okText="创建"
      cancelText="取消"
      onOk={() => onCreate(dbms)}
      onCancel={onCancel}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">选择目标数据库。模型在首次保存时选择保存位置。</Typography.Paragraph>
      <Radio.Group value={dbms} onChange={(e) => setDbms(e.target.value as DbmsKind)}>
        <Space direction="vertical">
          {DBMS_OPTIONS.map((o) => (
            <Radio key={o.kind} value={o.kind}>
              {o.label}
            </Radio>
          ))}
        </Space>
      </Radio.Group>
    </Modal>
  );
}
