/**
 * Editing model extracted from a PDM file.
 *
 * Plain serializable data (safe to send over Electron IPC). Object identity
 * uses the PDM document-local `Id` (e.g. `o25`); `objectId` is the GUID.
 * Data types are kept exactly as stored (`VARCHAR2(20)`, `NUMBER(18,2)`).
 */

export interface PdmModel {
  id: string;
  objectId: string;
  name: string;
  code: string;
  comment: string;
  /** DBMS target from the file header, e.g. `ORACLE Version 11g`. */
  target: string;
  /** PowerDesigner version that last saved the file, e.g. `16.7.5.6978`. */
  pdVersion: string;
  tables: PdmTable[];
  references: PdmReference[];
  diagrams: PdmDiagram[];
  views: PdmNamedObject[];
  sequences: PdmNamedObject[];
  users: PdmNamedObject[];
}

export interface PdmNamedObject {
  id: string;
  objectId: string;
  name: string;
  code: string;
  comment: string;
}

export interface PdmTable extends PdmNamedObject {
  ownerId: string | null;
  columns: PdmColumn[];
  keys: PdmKey[];
  primaryKeyId: string | null;
  indexes: PdmIndex[];
}

export interface PdmColumn extends PdmNamedObject {
  dataType: string;
  length: number | null;
  precision: number | null;
  mandatory: boolean;
  defaultValue: string;
}

export interface PdmKey extends PdmNamedObject {
  columnIds: string[];
}

export interface PdmIndex extends PdmNamedObject {
  unique: boolean;
  columnIds: string[];
}

export interface PdmReference extends PdmNamedObject {
  parentTableId: string;
  childTableId: string;
  parentKeyId: string | null;
  cardinality: string;
  joins: PdmReferenceJoin[];
}

export interface PdmReferenceJoin {
  id: string;
  parentColumnId: string | null;
  childColumnId: string | null;
}

export interface PdmDiagram extends PdmNamedObject {
  tableSymbols: PdmTableSymbol[];
  referenceSymbols: PdmReferenceSymbol[];
}

/** Rectangle in PowerDesigner model units (y axis points up). */
export interface PdmRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PdmTableSymbol {
  id: string;
  tableId: string;
  rect: PdmRect | null;
}

export interface PdmReferenceSymbol {
  id: string;
  referenceId: string;
  sourceSymbolId: string | null;
  destinationSymbolId: string | null;
  points: Array<[number, number]>;
}
