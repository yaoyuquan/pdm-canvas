import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { App as AntApp, Button, Empty, Space, Tabs, Tag, Tooltip, Typography } from 'antd';
import { FileAddOutlined, FolderOpenOutlined, RedoOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons';
import type { OpenedDocument, OpenResult } from '../shared/api';
import type { EditableAttr } from '../pdm/changes';
import { diffModel } from '../pdm/write';
import type { DbmsKind } from '../pdm/template';
import type { PdmModel } from '../pdm/types';
import {
  describeCommand,
  historyReducer,
  modelCommand,
  setAttrCommand,
  type EditTarget,
  type History,
  type HistoryAction,
} from '../editing/commands';
import {
  addColumn,
  addReference,
  addTable,
  deleteColumns,
  deleteReferences,
  deleteTables,
  deleteTableSymbols,
  moveColumn,
  moveTableSymbols,
  setPrimary,
  type SymbolMove,
} from '../editing/structure';
import type { Selection } from './selection';
import { ModelTree } from './components/ModelTree';
import { DiagramCanvas, type CanvasTool } from './components/DiagramCanvas';
import { PropertyPanel } from './components/PropertyPanel';
import { NewModelDialog } from './components/NewModelDialog';
import { DeleteTableDialog } from './components/DeleteTableDialog';
import type { ColumnActions } from './components/ColumnGrid';

/**
 * Workbench root: toolbar, model tree, diagram canvas, property panel, and
 * status bar. Owns the open document and the edit history; all edits flow
 * through the command layer (`editing/commands.ts`).
 */

const isMac = navigator.platform.toLowerCase().includes('mac');
/** Modifier key prefix shown in shortcut hints. */
const MOD = isMac ? '⌘' : 'Ctrl+';

/** History reducer that also accepts "no document yet" (null) as state. */
function reducer(state: History | null, action: HistoryAction): History | null {
  if (action.type === 'reset') return historyReducer({ model: action.model, past: [], future: [] }, action);
  return state ? historyReducer(state, action) : state;
}

/** True for elements that handle their own typing and undo (inputs, editors). */
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
  /** Current model plus undo/redo stacks; null until a document is open. */
  const [history, dispatch] = useReducer(reducer, null);
  /** Table, column, or reference selected in the tree or on the canvas. */
  const [selection, setSelection] = useState<Selection>(null);
  /** Diagram shown in the canvas tab. */
  const [diagramId, setDiagramId] = useState<string | null>(null);
  /** True while a file dialog or IPC call is in flight; disables file actions. */
  const [busy, setBusy] = useState(false);
  /** Whether the "新建模型" (choose database) dialog is showing. */
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  /** Active canvas palette tool; "table" places a new table on each click. */
  const [tool, setTool] = useState<CanvasTool>('select');
  /** Table waiting for the "删除对象 / 仅删除图形" decision. */
  const [deletingTableId, setDeletingTableId] = useState<string | null>(null);

  const model = history?.model ?? null;
  // Unsaved changes are the diff against the last opened/saved model, so
  // undoing back to that state makes the document clean again.
  const changes = useMemo(() => (doc && model ? diffModel(doc.model, model) : []), [doc, model]);
  const dirty = changes.length > 0;
  const diagram = useMemo(() => model?.diagrams.find((d) => d.id === diagramId) ?? null, [model, diagramId]);

  // Latest state for async handlers and the global key listener.
  const latest = useRef({ doc, model, dirty, selection, diagram });
  latest.current = { doc, model, dirty, selection, diagram };

  /** Resolves true if there is nothing to lose or the user agrees to discard edits. */
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

  /**
   * Shows a document returned by the main process (opened or newly created)
   * and starts a fresh edit history. `null` means there was nothing to open.
   */
  const load = async (open: () => Promise<OpenResult | null>) => {
    setBusy(true);
    try {
      const res = await open();
      if (!res) return;
      if (res.ok) {
        setDoc(res.doc);
        dispatch({ type: 'reset', model: res.doc.model });
        setSelection(null);
        // Prefer the first diagram that actually shows tables.
        const first = res.doc.model.diagrams.find((d) => d.tableSymbols.length > 0) ?? res.doc.model.diagrams[0];
        setDiagramId(first?.id ?? null);
        // A new model has no file path yet; it is only written on first save.
        message.success(
          res.doc.filePath ? `已打开 ${res.doc.fileName}` : `已新建 ${res.doc.model.target} 模型，保存时选择保存位置`,
        );
      } else if (!res.canceled) {
        message.error(`导入失败：${res.error}`);
      }
    } finally {
      setBusy(false);
    }
  };

  /** "导入 PDM": pick a file and open it, after confirming unsaved edits. */
  const openFile = async () => {
    await flushPendingEdit();
    if (await confirmDiscard()) await load(() => window.pdmApi.openFile());
  };

  /** "新建": confirms discarding unsaved edits, then asks for the database type. */
  const newModel = async () => {
    await flushPendingEdit();
    if (await confirmDiscard()) setNewDialogOpen(true);
  };

  /** Creates the model in the main process and opens it like an imported file. */
  const createModel = async (dbms: DbmsKind) => {
    setNewDialogOpen(false);
    await load(() => window.pdmApi.newDocument(dbms));
  };

  /**
   * Sends the changes since the last save to the main process, which splices
   * them into the original file. The main process decides whether to ask for
   * a path (Save As, first save of an import, or a new model).
   */
  const save = async (saveAs: boolean) => {
    // Commit a half-typed property value so it is included in the save.
    await flushPendingEdit();
    const { doc: d, model: m } = latest.current;
    if (!d || !m) return;
    setBusy(true);
    try {
      const res = await window.pdmApi.save({ docId: d.docId, model: m, saveAs });
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

  /** Property panel edits become commands, so they can be undone. */
  const edit = (target: EditTarget, attr: EditableAttr, value: string) => {
    if (!model) return;
    const command = setAttrCommand(model, target, attr, value);
    if (command) dispatch({ type: 'exec', command });
  };

  /**
   * Runs a structural edit as one undoable command. Returns the new model,
   * or null when nothing changed.
   */
  const runEdit = (label: string, change: (m: PdmModel) => PdmModel): PdmModel | null => {
    const before = latest.current.model;
    if (!before) return null;
    const command = modelCommand(label, before, change(before));
    if (!command) return null;
    dispatch({ type: 'exec', command });
    // Handlers called right after (same event) must see the new model.
    latest.current = { ...latest.current, model: command.after };
    return command.after;
  };

  /** Palette "表" tool: creates `Table_n` centered at the clicked point. */
  const placeTable = (point: { x: number; y: number }) => {
    const { model: m, diagram: d } = latest.current;
    if (!m || !d) return;
    const { model: after, tableId } = addTable(m, d.id, point);
    const name = after.tables.find((t) => t.id === tableId)!.code;
    runEdit(`新建表 ${name}`, () => after);
    // Select it so the property panel is ready for columns (as PowerDesigner opens it).
    setSelection({ type: 'table', tableId });
  };

  /** Dragging tables on the canvas: moves their symbols (and attached links). */
  const moveSymbols = (moves: SymbolMove[]) => {
    const { model: m, diagram: d } = latest.current;
    if (!m || !d) return;
    const tableId = d.tableSymbols.find((s) => s.id === moves[0]?.symbolId)?.tableId;
    runEdit(`移动 ${tableId ? label(tableId) : '图形'}`, (mm) => moveTableSymbols(mm, d.id, moves));
  };

  /**
   * A link drawn on the canvas from a child table to a parent table: creates
   * the reference (migrating the parent key) and selects it.
   */
  const createReference = (childSymbolId: string, parentSymbolId: string) => {
    const { model: m, diagram: d } = latest.current;
    if (!m || !d) return;
    const { model: after, referenceId } = addReference(m, d.id, childSymbolId, parentSymbolId);
    const r = after.references.find((x) => x.id === referenceId)!;
    runEdit(`新建关系 ${label(r.childTableId)} → ${label(r.parentTableId)}`, () => after);
    setSelection({ type: 'reference', referenceId });
  };

  /** Code of a table or `TABLE.COLUMN`, for undo labels. */
  const label = (tableId: string, columnId?: string) => {
    const t = latest.current.model?.tables.find((x) => x.id === tableId);
    const c = columnId ? t?.columns.find((x) => x.id === columnId) : undefined;
    return c ? `${t?.code}.${c.code}` : (t?.code ?? '');
  };

  /** Column operations from the column grid. */
  const columnActions: ColumnActions = {
    add: (tableId, index) => {
      const m = latest.current.model;
      if (!m) return null;
      const { model: after, columnId } = addColumn(m, tableId, index);
      runEdit(`新建字段 ${label(tableId)}`, () => after);
      return columnId;
    },
    remove: (tableId, columnId) => {
      runEdit(`删除字段 ${label(tableId, columnId)}`, (m) => deleteColumns(m, tableId, [columnId]));
      // The column's own property page would be empty now.
      const sel = latest.current.selection;
      if (sel?.type === 'column' && sel.columnId === columnId) setSelection({ type: 'table', tableId });
    },
    move: (tableId, columnId, delta) =>
      runEdit(`移动字段 ${label(tableId, columnId)}`, (m) => moveColumn(m, tableId, columnId, delta)),
    setPrimary: (tableId, columnId, primary) =>
      runEdit(`${primary ? '设为主键' : '取消主键'} ${label(tableId, columnId)}`, (m) =>
        setPrimary(m, tableId, columnId, primary),
      ),
  };

  /** Delete key: deletes the selected table (asks how), column, or reference. */
  const deleteSelection = () => {
    const { selection: sel, model: m } = latest.current;
    if (!sel || !m) return;
    if (sel.type === 'table') {
      setDeletingTableId(sel.tableId);
    } else if (sel.type === 'column') {
      columnActions.remove(sel.tableId, sel.columnId);
    } else {
      const r = m.references.find((x) => x.id === sel.referenceId);
      runEdit(`删除关系 ${r?.code ?? ''}`, (mm) => deleteReferences(mm, [sel.referenceId]));
      setSelection(null);
    }
  };

  /** "删除对象": the table, its references, and all its symbols. */
  const deleteTableObject = () => {
    const id = deletingTableId;
    setDeletingTableId(null);
    if (!id) return;
    runEdit(`删除表 ${label(id)}`, (m) => deleteTables(m, [id]));
    setSelection(null);
  };

  /** "仅删除图形": removes the table only from the current diagram. */
  const deleteTableSymbol = () => {
    const id = deletingTableId;
    const d = latest.current.diagram;
    setDeletingTableId(null);
    if (!id || !d) return;
    runEdit(`从关系图移除 ${label(id)}`, (m) => deleteTableSymbols(m, d.id, [id]));
    setSelection(null);
  };

  // The global key listener is registered once; it calls the latest handlers
  // through this ref instead of capturing stale closures.
  const actions = useRef({
    newModel,
    openFile,
    save,
    deleteSelection,
    undo: () => dispatch({ type: 'undo' }),
    redo: () => dispatch({ type: 'redo' }),
  });
  actions.current = {
    newModel,
    openFile,
    save,
    deleteSelection,
    undo: () => dispatch({ type: 'undo' }),
    redo: () => dispatch({ type: 'redo' }),
  };

  // Open the .pdm passed on the command line (e.g. `npm start -- file.pdm`).
  const startupLoaded = useRef(false);
  useEffect(() => {
    // StrictMode runs effects twice in dev; open the startup file only once.
    if (startupLoaded.current) return;
    startupLoaded.current = true;
    load(() => window.pdmApi.openStartupFile());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global shortcuts: Ctrl+N/O/S/Shift+S for files, Ctrl+Z/Y for model undo/redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Plain keys outside text inputs: Escape leaves the palette tool, Delete deletes.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !isTextInput(e.target)) {
        if (e.key === 'Escape') setTool('select');
        // Dialogs (e.g. the delete confirmation) handle their own keys.
        else if (e.key === 'Delete' && !document.querySelector('.ant-modal-wrap')) {
          e.preventDefault();
          actions.current.deleteSelection();
        }
        return;
      }
      // Only Ctrl/Cmd combinations; Alt combinations belong to the OS/menus.
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      const a = actions.current;
      if (key === 's') {
        e.preventDefault();
        if (latest.current.doc) a.save(e.shiftKey);
      } else if (key === 'o') {
        e.preventDefault();
        a.openFile();
      } else if (key === 'n' && !e.shiftKey) {
        // Ctrl+N: new model. Ctrl+Shift+N is left alone.
        e.preventDefault();
        a.newModel();
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

  // Window title shows the file name and a dot while there are unsaved edits.
  useEffect(() => {
    document.title = doc ? `${dirty ? '● ' : ''}${doc.fileName} - PDM Canvas` : 'PDM Canvas';
  }, [doc, dirty]);

  // Commands that undo/redo would apply next; used for button tooltips.
  const undoCmd = history?.past[history.past.length - 1];
  const redoCmd = history?.future[0];

  return (
    <div className="workbench">
      {/* Toolbar: file actions, save, undo/redo, and the open file's name. */}
      <header className="toolbar">
        <span className="brand">PDM Canvas</span>
        <Space.Compact>
          <Tooltip title={`新建模型（${MOD}N）`}>
            <Button icon={<FileAddOutlined />} disabled={busy} onClick={newModel}>
              新建
            </Button>
          </Tooltip>
          <Tooltip title={`导入 PDM（${MOD}O）`}>
            <Button icon={<FolderOpenOutlined />} loading={busy} onClick={openFile}>
              导入 PDM
            </Button>
          </Tooltip>
        </Space.Compact>
        <Space.Compact>
          {/* The tooltip explains where the first save of a new or imported model goes. */}
          <Tooltip
            title={
              doc && !doc.filePath
                ? `保存（${MOD}S）：选择保存位置和文件名`
                : doc && !doc.savedByApp
                  ? `保存（${MOD}S）：首次保存会另存为新文件，不覆盖导入的原文件`
                  : `保存（${MOD}S）`
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
        {/* Right side: dirty marker, file name, and target DBMS. */}
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
        // Nothing open yet: offer the two ways to start.
        <main className="welcome">
          <Empty description="新建模型，或打开 PowerDesigner 物理数据模型（XML 格式 .pdm）开始编辑">
            <Space>
              <Button type="primary" icon={<FileAddOutlined />} disabled={busy} onClick={newModel}>
                新建模型
              </Button>
              <Button icon={<FolderOpenOutlined />} loading={busy} onClick={openFile}>
                导入 PDM
              </Button>
            </Space>
          </Empty>
        </main>
      ) : (
        // Three panes: model tree | diagram canvas | property panel.
        <div className="panes">
          <aside className="pane pane-left">
            <ModelTree model={model} selection={selection} onSelect={setSelection} />
          </aside>
          <main className="pane-center">
            {/* One tab per PowerDesigner diagram in the model. */}
            <Tabs
              size="small"
              className="diagram-tabs"
              activeKey={diagramId ?? undefined}
              onChange={setDiagramId}
              items={model.diagrams.map((d) => ({ key: d.id, label: d.name || d.code }))}
            />
            {diagram ? (
              <DiagramCanvas
                model={model}
                diagram={diagram}
                selection={selection}
                onSelect={setSelection}
                tool={tool}
                onToolChange={setTool}
                onPlaceTable={placeTable}
                onMoveSymbols={moveSymbols}
                onCreateReference={createReference}
              />
            ) : (
              <Empty className="canvas-empty" description="模型中没有关系图" />
            )}
          </main>
          <aside className="pane pane-right">
            <PropertyPanel
              model={model}
              selection={selection}
              onSelect={setSelection}
              onEdit={edit}
              columnActions={columnActions}
            />
          </aside>
        </div>
      )}

      {/* Status bar: model statistics, save state, and file location. */}
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
            {doc.filePath ? <span title={doc.filePath}>{doc.filePath}</span> : <span>新模型，尚未保存</span>}
          </>
        ) : (
          <span>未打开文件</span>
        )}
      </footer>

      {/* PowerDesigner-style choice when deleting a table. */}
      {model && (
        <DeleteTableDialog
          model={model}
          tableId={deletingTableId}
          hasSymbol={!!diagram?.tableSymbols.some((s) => s.tableId === deletingTableId)}
          onDeleteObject={deleteTableObject}
          onDeleteSymbol={deleteTableSymbol}
          onCancel={() => setDeletingTableId(null)}
        />
      )}

      {/* Asks for the database type when creating a new model. */}
      <NewModelDialog open={newDialogOpen} onCreate={createModel} onCancel={() => setNewDialogOpen(false)} />
    </div>
  );
}
