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
  /**
   * Highest numeric part of any `Id` in the file (`o123` -> 123). New
   * objects get Ids above it, so they never collide with existing ones.
   */
  maxIdNum: number;
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
  /** Id of the model or package whose `c:Tables` holds this table. */
  parentId: string;
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
  /**
   * Foreign key column that PowerDesigner created by migrating a parent key
   * column (`AutoMigrated`). Deleting the reference deletes such a column.
   */
  autoMigrated: boolean;
}

export interface PdmKey extends PdmNamedObject {
  columnIds: string[];
}

export interface PdmIndex extends PdmNamedObject {
  unique: boolean;
  columnIds: string[];
}

export interface PdmReference extends PdmNamedObject {
  /** Id of the model or package whose `c:References` holds this reference. */
  parentId: string;
  parentTableId: string;
  childTableId: string;
  parentKeyId: string | null;
  cardinality: string;
  joins: PdmReferenceJoin[];
}

export interface PdmReferenceJoin {
  id: string;
  objectId: string;
  parentColumnId: string | null;
  childColumnId: string | null;
}

export interface PdmDiagram extends PdmNamedObject {
  /** Id of the model or package that owns the diagram; new tables go there. */
  parentId: string;
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
  /** Bounding box including the label area, as PowerDesigner stores it. */
  rect: PdmRect | null;
  /** Polyline from the source table symbol to the destination table symbol. */
  points: Array<[number, number]>;
  /** Right-angle routing (`CornerStyle` 2): segments are horizontal or vertical. */
  orthogonal: boolean;
}
