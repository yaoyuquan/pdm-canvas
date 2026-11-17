import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { App as AntApp, Button, Empty, Space, Tabs, Tag, Tooltip, Typography } from 'antd';
import { FolderOpenOutlined, RedoOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons';
import type { OpenedDocument, OpenResult } from '../shared/api';
import { diffAttributes, type EditableAttr } from '../pdm/changes';
import {
  describeCommand,
  historyReducer,
  setAttrCommand,
  type EditTarget,
  type History,
  type HistoryAction,
} from '../editing/commands';
import type { Selection } from './selection';
import { ModelTree } from './components/ModelTree';
import { DiagramCanvas } from './components/DiagramCanvas';
import { PropertyPanel } from './components/PropertyPanel';

const isMac = navigator.platform.toLowerCase().includes('mac');
const MOD = isMac ? '⌘' : 'Ctrl+';

function reducer(state: History | null, action: HistoryAction): History | null {
  if (action.type === 'reset') return historyReducer({ model: action.model, past: [], future: [] }, action);
  return state ? historyReducer(state, action) : state;
}

function isTextInput(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** Lets a focused property input commit (on blur) before an action reads the model. */
async function flushPendingEdit(): Promise<void> {
  if (isTextInput(document.activeElement)) {
    (document.activeElement as HTMLElement).blur();
    await new Promise((r) => setTimeout(r, 0));
  }
}

export function App() {
  const { message, modal } = AntApp.useApp();
  /** File metadata plus the model as last opened/saved (the base for diffs). */
  const [doc, setDoc] = useState<OpenedDocument | null>(null);
  const [history, dispatch] = useReducer(reducer, null);
  const [selection, setSelection] = useState<Selection>(null);
  const [diagramId, setDiagramId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const model = history?.model ?? null;
  const changes = useMemo(() => (doc && model ? diffAttributes(doc.model, model) : []), [doc, model]);
  const dirty = changes.length > 0;
  const diagram = useMemo(() => model?.diagrams.find((d) => d.id === diagramId) ?? null, [model, diagramId]);

  // Latest state for async handlers and the global key listener.
  const latest = useRef({ doc, model, dirty });
  latest.current = { doc, model, dirty };

  const confirmDiscard = () =>
    new Promise<boolean>((resolve) => {
      if (!latest.current.dirty) return resolve(true);
      modal.confirm({
        title: '放弃未保存的修改？',
        content: '当前模型有未保存的修改，继续操作后这些修改将会丢失。',
        okText: '放弃修改',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });

  const load = async (open: () => Promise<OpenResult | null>) => {
    setBusy(true);
    try {
      const res = await open();
      if (!res) return;
      if (res.ok) {
        setDoc(res.doc);
        dispatch({ type: 'reset', model: res.doc.model });
        setSelection(null);
        const first = res.doc.model.diagrams.find((d) => d.tableSymbols.length > 0) ?? res.doc.model.diagrams[0];
        setDiagramId(first?.id ?? null);
        message.success(`已打开 ${res.doc.fileName}`);
      } else if (!res.canceled) {
        message.error(`导入失败：${res.error}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const openFile = async () => {
    await flushPendingEdit();
    if (await confirmDiscard()) await load(() => window.pdmApi.openFile());
  };

  const save = async (saveAs: boolean) => {
    await flushPendingEdit();
    const { doc: d, model: m } = latest.current;
    if (!d || !m) return;
    setBusy(true);
    try {
      const res = await window.pdmApi.save({ docId: d.docId, changes: diffAttributes(d.model, m), saveAs });
      if (res.ok) {
        // The saved file, re-read from disk, becomes the new base; history is kept.
        setDoc(res.doc);
        message.success(`已保存到 ${res.doc.fileName}`);
      } else if (!res.canceled) {
        message.error(`保存失败：${res.error}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const edit = (target: EditTarget, attr: EditableAttr, value: string) => {
    if (!model) return;
    const command = setAttrCommand(model, target, attr, value);
    if (command) dispatch({ type: 'exec', command });
  };

  const actions = useRef({
    openFile,
    save,
    undo: () => dispatch({ type: 'undo' }),
    redo: () => dispatch({ type: 'redo' }),
  });
  actions.current = { openFile, save, undo: () => dispatch({ type: 'undo' }), redo: () => dispatch({ type: 'redo' }) };

  const startupLoaded = useRef(false);
  useEffect(() => {
    // StrictMode runs effects twice in dev; open the startup file only once.
    if (startupLoaded.current) return;
    startupLoaded.current = true;
    load(() => window.pdmApi.openStartupFile());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      const a = actions.current;
      if (key === 's') {
        e.preventDefault();
        if (latest.current.doc) a.save(e.shiftKey);
      } else if (key === 'o') {
        e.preventDefault();
        a.openFile();
      } else if (!isTextInput(e.target) && ((key === 'z' && e.shiftKey) || key === 'y')) {
        // Inside inputs, undo/redo stay native to the input.
        e.preventDefault();
        a.redo();
      } else if (!isTextInput(e.target) && key === 'z') {
        e.preventDefault();
        a.undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Block closing/reloading with unsaved changes; the main process asks the user.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    document.title = doc ? `${dirty ? '● ' : ''}${doc.fileName} - PDM Canvas` : 'PDM Canvas';
  }, [doc, dirty]);

  const undoCmd = history?.past[history.past.length - 1];
  const redoCmd = history?.future[0];

  return (
    <div className="workbench">
      <header className="toolbar">
        <span className="brand">PDM Canvas</span>
        <Space.Compact>
          <Tooltip title={`导入 PDM（${MOD}O）`}>
            <Button icon={<FolderOpenOutlined />} loading={busy} onClick={openFile}>
              导入 PDM
            </Button>
          </Tooltip>
        </Space.Compact>
        <Space.Compact>
          <Tooltip
            title={
              doc && !doc.savedByApp ? `保存（${MOD}S）：首次保存会另存为新文件，不覆盖导入的原文件` : `保存（${MOD}S）`
            }
          >
            <Button icon={<SaveOutlined />} disabled={!doc || busy} onClick={() => save(false)}>
              保存
            </Button>
          </Tooltip>
          <Tooltip title={`另存为（${MOD}Shift+S）`}>
            <Button disabled={!doc || busy} onClick={() => save(true)}>
              另存为
            </Button>
          </Tooltip>
        </Space.Compact>
        <Space.Compact>
          <Tooltip title={undoCmd && model ? `撤销：${describeCommand(model, undoCmd)}（${MOD}Z）` : '撤销'}>
            <Button icon={<UndoOutlined />} disabled={!undoCmd} onClick={() => dispatch({ type: 'undo' })} />
          </Tooltip>
          <Tooltip title={redoCmd && model ? `重做：${describeCommand(model, redoCmd)}（${MOD}Y）` : '重做'}>
            <Button icon={<RedoOutlined />} disabled={!redoCmd} onClick={() => dispatch({ type: 'redo' })} />
          </Tooltip>
        </Space.Compact>
        <span className="toolbar-spacer" />
        {doc && model && (
          <Typography.Text type="secondary" className="toolbar-file">
            {dirty && (
              <span className="dirty-dot" title="有未保存的修改">
                ●
              </span>
            )}
            {doc.fileName}
            <Tag color="blue" className="toolbar-tag">
              {model.target}
            </Tag>
          </Typography.Text>
        )}
      </header>

      {!model ? (
        <main className="welcome">
          <Empty description="打开 PowerDesigner 物理数据模型（XML 格式 .pdm）开始编辑">
            <Button type="primary" icon={<FolderOpenOutlined />} loading={busy} onClick={openFile}>
              导入 PDM
            </Button>
          </Empty>
        </main>
      ) : (
        <div className="panes">
          <aside className="pane pane-left">
            <ModelTree model={model} selection={selection} onSelect={setSelection} />
          </aside>
          <main className="pane-center">
            <Tabs
              size="small"
              className="diagram-tabs"
              activeKey={diagramId ?? undefined}
              onChange={setDiagramId}
              items={model.diagrams.map((d) => ({ key: d.id, label: d.name || d.code }))}
            />
            {diagram ? (
              <DiagramCanvas model={model} diagram={diagram} selection={selection} onSelect={setSelection} />
            ) : (
              <Empty className="canvas-empty" description="模型中没有关系图" />
            )}
          </main>
          <aside className="pane pane-right">
            <PropertyPanel model={model} selection={selection} onSelect={setSelection} onEdit={edit} />
          </aside>
        </div>
      )}

      <footer className="statusbar">
        {model && doc ? (
          <>
            <span>{model.target}</span>
            <span>表 {model.tables.length}</span>
            <span>关系 {model.references.length}</span>
            <span>关系图 {model.diagrams.length}</span>
            <span>PowerDesigner {model.pdVersion}</span>
            {dirty ? (
              <span className="statusbar-dirty">未保存的修改 {changes.length} 处</span>
            ) : doc.savedByApp ? (
              <span>已保存</span>
            ) : null}
            <span className="statusbar-spacer" />
            <span title={doc.filePath}>{doc.filePath}</span>
          </>
        ) : (
          <span>未打开文件</span>
        )}
      </footer>
    </div>
  );
}
