/**
 * Holds parsed PDM documents (original text + offsets) in the main process
 * and serves the renderer over IPC. The renderer only ever receives the
 * plain editing model; write-back happens here against the original text.
 *
 * TODO: move parsing/serialization into an Electron utility process
 * (CLAUDE.md rule 4) once files are large enough to stall the main process.
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DBMS_OPTIONS, instantiateTemplate, readPdm, writeModel, type DbmsKind, type PdmDocument } from '../pdm';
import { IPC, type OpenedDocument, type OpenResult, type SaveRequest, type SaveResult } from '../shared/api';
import oracle11gTemplate from '../../resources/templates/oracle11g.pdm?raw';
import mysql50Template from '../../resources/templates/mysql50.pdm?raw';
import postgresql9Template from '../../resources/templates/postgresql9.pdm?raw';

/**
 * Blank models saved by PowerDesigner 16.7.5, bundled into the main process
 * as strings (Vite `?raw`), so packaging needs no extra resource files.
 * Vite keeps the CRLF line endings PowerDesigner writes.
 */
const TEMPLATES: Record<DbmsKind, string> = {
  oracle11g: oracle11gTemplate,
  mysql50: mysql50Template,
  postgresql9: postgresql9Template,
};

interface OpenDoc {
  /** Null until a new model is saved for the first time. */
  filePath: string | null;
  pdm: PdmDocument;
  savedByApp: boolean;
}

const docs = new Map<string, OpenDoc>();

const PDM_FILTERS: Electron.FileFilter[] = [
  { name: 'PowerDesigner 物理数据模型', extensions: ['pdm'] },
  { name: '所有文件', extensions: ['*'] },
];

function errorResult(err: unknown): { ok: false; canceled: false; error: string } {
  return { ok: false, canceled: false, error: err instanceof Error ? err.message : String(err) };
}

function toOpened(docId: string, d: OpenDoc): OpenedDocument {
  return {
    docId,
    filePath: d.filePath,
    fileName: d.filePath ? path.basename(d.filePath) : newFileName(d.pdm),
    model: d.pdm.model,
    savedByApp: d.savedByApp,
  };
}

/** Suggested file name for a model that has no file yet, from its Code. */
function newFileName(pdm: PdmDocument): string {
  return `${pdm.model.code || pdm.model.name || 'NewModel'}.pdm`;
}

/** OS login name, which PowerDesigner also records as Creator/Modifier. */
function currentUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    // userInfo() throws when the account has no username or home directory.
    return 'PDMCanvas';
  }
}

/**
 * Creates an unsaved model for the given DBMS from its blank template.
 * The document has no file path, so its first save always asks where to save.
 */
export function newPdmDocument(dbms: DbmsKind): OpenResult {
  try {
    // The value comes over IPC, so check it rather than trusting the type.
    if (!DBMS_OPTIONS.some((o) => o.kind === dbms)) throw new Error(`不支持的数据库类型：${dbms}`);
    const text = instantiateTemplate(TEMPLATES[dbms], { user: currentUser(), now: new Date(), newGuid: randomUUID });
    const docId = randomUUID();
    // Kept only in memory until saved; nothing is written to disk here.
    const d: OpenDoc = { filePath: null, pdm: readPdm(text), savedByApp: false };
    docs.set(docId, d);
    return { ok: true, doc: toOpened(docId, d) };
  } catch (err) {
    return errorResult(err);
  }
}

export async function openPdmFile(filePath: string): Promise<OpenResult> {
  try {
    const source = await fs.readFile(filePath, 'utf8');
    const docId = randomUUID();
    const d: OpenDoc = { filePath, pdm: readPdm(source), savedByApp: false };
    docs.set(docId, d);
    return { ok: true, doc: toOpened(docId, d) };
  } catch (err) {
    return errorResult(err);
  }
}

async function savePdm(win: BrowserWindow | null, req: SaveRequest): Promise<SaveResult> {
  const d = docs.get(req.docId);
  if (!d) return errorResult(new Error('文档已关闭或不存在'));

  let target = d.filePath;
  // Ask for a path on Save As, on the first save of an imported file (never
  // overwrite the original silently), and for a new model that has no file yet.
  if (req.saveAs || !d.savedByApp || !target) {
    let defaultPath: string;
    if (target) {
      // Existing file: suggest a sibling copy next to it.
      const parsed = path.parse(target);
      defaultPath = path.join(parsed.dir, `${parsed.name}_edited${parsed.ext || '.pdm'}`);
    } else {
      // New model: start in the user's Documents folder.
      defaultPath = path.join(app.getPath('documents'), newFileName(d.pdm));
    }
    const options: Electron.SaveDialogOptions = {
      title: target ? '另存为 PDM' : '保存 PDM',
      defaultPath,
      filters: PDM_FILTERS,
    };
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    target = picked.filePath;
  }

  try {
    // New objects are stamped with the OS user and save time, like PowerDesigner does.
    const text = writeModel(d.pdm, req.model, { user: currentUser(), now: new Date() });
    // Re-read before touching disk: never write a file we cannot open again.
    const pdm = readPdm(text);
    // Write to a temp file and rename, so a failure never leaves a half-written PDM.
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, target);
    const saved: OpenDoc = { filePath: target, pdm, savedByApp: true };
    docs.set(req.docId, saved);
    return { ok: true, doc: toOpened(req.docId, saved) };
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * A `.pdm` path from the command line. Not cleared after use, so a renderer
 * reload (e.g. Vite's dependency re-optimization in dev) reopens it.
 */
const startupFile: string | null = process.argv.slice(1).find((a) => a.toLowerCase().endsWith('.pdm')) ?? null;

export function registerDocumentIpc(): void {
  // New model from a template; the renderer asked for the DBMS beforehand.
  ipcMain.handle(IPC.new, (_event, dbms: DbmsKind): OpenResult => newPdmDocument(dbms));

  ipcMain.handle(
    IPC.openStartup,
    async (): Promise<OpenResult | null> => (startupFile ? openPdmFile(path.resolve(startupFile)) : null),
  );

  ipcMain.handle(IPC.open, async (event): Promise<OpenResult> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = { title: '导入 PDM', filters: PDM_FILTERS, properties: ['openFile'] };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true };
    return openPdmFile(picked.filePaths[0]);
  });

  ipcMain.handle(IPC.save, (event, req: SaveRequest) => savePdm(BrowserWindow.fromWebContents(event.sender), req));
}
