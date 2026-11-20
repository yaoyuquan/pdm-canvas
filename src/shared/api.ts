/**
 * IPC contract between the main process and the renderer.
 * The preload script exposes `PdmApi` as `window.pdmApi`.
 */
import type { DbmsKind } from '../pdm/template';
import type { PdmModel } from '../pdm/types';

export const IPC = {
  new: 'pdm:new',
  open: 'pdm:open',
  openStartup: 'pdm:open-startup',
  save: 'pdm:save',
} as const;

export interface OpenedDocument {
  /** Handle for the parsed document held by the main process. */
  docId: string;
  /** Null for a new model that has not been saved yet. */
  filePath: string | null;
  /** File name, or the suggested one for a new model. */
  fileName: string;
  model: PdmModel;
  /**
   * True once the document has been saved by PDM Canvas. Until then, Save
   * behaves like Save As so the imported original is never overwritten silently.
   */
  savedByApp: boolean;
}

export type OpenResult =
  | { ok: true; doc: OpenedDocument }
  | { ok: false; canceled: true }
  | { ok: false; canceled: false; error: string };

export interface SaveRequest {
  docId: string;
  /**
   * The edited model. The main process compares it with the model as last
   * opened/saved and writes only the differences into the original text.
   */
  model: PdmModel;
  /** Always ask for a target path. */
  saveAs: boolean;
}

/** On success, `doc.model` is the saved file re-read from disk. */
export type SaveResult = OpenResult;

export interface PdmApi {
  /** Creates an unsaved model from the blank template for the given DBMS. */
  newDocument(dbms: DbmsKind): Promise<OpenResult>;
  /** Shows a file picker and parses the chosen PDM file. */
  openFile(): Promise<OpenResult>;
  /** Opens the `.pdm` passed on the command line, if any. */
  openStartupFile(): Promise<OpenResult | null>;
  /** Writes changes into the document's original text and saves it. */
  save(req: SaveRequest): Promise<SaveResult>;
}

declare global {
  interface Window {
    pdmApi: PdmApi;
  }
}
