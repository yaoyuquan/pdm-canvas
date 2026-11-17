/** What the user currently has selected in the workbench. */
export type Selection =
  | { type: 'table'; tableId: string }
  | { type: 'column'; tableId: string; columnId: string }
  | { type: 'reference'; referenceId: string }
  | null;

export function selectedTableId(sel: Selection): string | null {
  return sel && sel.type !== 'reference' ? sel.tableId : null;
}
