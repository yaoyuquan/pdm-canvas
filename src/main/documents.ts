/**
 * Holds parsed PDM documents (original text + offsets) in the main process
 * and serves the renderer over IPC. The renderer only ever receives the
 * plain editing model; write-back happens here against the original text.
 *
 * TODO: move parsing/serialization into an Electron utility process
 * (CLAUDE.md rule 4) once files are large enough to stall the main process.
 */
import { BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPdm, writeChanges, type PdmDocument } from '../pdm';
import { IPC, type OpenedDocument, type OpenResult, type SaveRequest, type SaveResult } from '../shared/api';

interface OpenDoc {
  filePath: string;
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
    fileName: path.basename(d.filePath),
    model: d.pdm.model,
    savedByApp: d.savedByApp,
  };
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
  if (req.saveAs || !d.savedByApp) {
    const parsed = path.parse(d.filePath);
    const options: Electron.SaveDialogOptions = {
      title: '另存为 PDM',
      defaultPath: path.join(parsed.dir, `${parsed.name}_edited${parsed.ext || '.pdm'}`),
      filters: PDM_FILTERS,
    };
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    target = picked.filePath;
  }

  try {
    const text = writeChanges(d.pdm, req.changes);
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
