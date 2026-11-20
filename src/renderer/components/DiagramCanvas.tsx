import { useEffect, useRef } from 'react';
import { Button, Empty, Tooltip } from 'antd';
import { ArrowRightOutlined, NodeIndexOutlined, SelectOutlined, TableOutlined } from '@ant-design/icons';
import { Graph, type Edge, type Node } from '@antv/x6';
import type { PdmDiagram, PdmModel, PdmTable } from '../../pdm/types';
import type { SymbolMove } from '../../editing/structure';
import { selectedTableId, type Selection } from '../selection';

/** Palette tools, as in PowerDesigner's toolbox: pointer, "Table", and "Reference". */
export type CanvasTool = 'select' | 'table' | 'reference';

interface Props {
  model: PdmModel;
  /** The PowerDesigner diagram to show (its symbols carry the layout). */
  diagram: PdmDiagram;
  selection: Selection;
  /** Clicking a table/reference selects it; clicking empty canvas clears. */
  onSelect: (sel: Selection) => void;
  tool: CanvasTool;
  onToolChange: (tool: CanvasTool) => void;
  /** With the "表" tool: a click on empty canvas, in PowerDesigner units (y up). */
  onPlaceTable: (center: { x: number; y: number }) => void;
  /** A table symbol was dragged; offsets in PowerDesigner units (y up). */
  onMoveSymbols: (moves: SymbolMove[]) => void;
  /** A link was drawn from the child table's symbol to the parent table's symbol. */
  onCreateReference: (childSymbolId: string, parentSymbolId: string) => void;
}

/** PowerDesigner model units per screen pixel at 100% zoom. */
const PD_UNITS_PER_PX = 50;
/** Table node header height in px. */
const HEADER_H = 26;
/** Height of one column row in px. */
const ROW_H = 18;
/** Columns listed per table before collapsing the rest into "… 另有 N 个字段". */
const MAX_ROWS = 14;
/** Width in screen px of the band along a table's border where a link can be started. */
const EDGE_BAND = 7;
/** Id of the dashed edge shown while a link is being drawn. */
const PREVIEW_ID = '__link-preview';

/** SVG attributes cannot resolve CSS variables, so canvas colors live here. */
const C = {
  canvasBg: '#f7f8fa',
  grid: '#d5d9e0',
  nodeBg: '#ffffff',
  nodeHeader: '#eef3fe',
  nodeBorder: '#b8c4d9',
  nodeTitle: '#1f2329',
  nodeText: '#3a3f47',
  edge: '#7b8494',
  accent: '#2f6fed',
  mono: "'JetBrains Mono', 'Cascadia Mono', Consolas, 'SF Mono', Menlo, monospace",
};

/** Node title: code, plus the display name when it differs (often Chinese). */
function tableTitle(t: PdmTable): string {
  return t.name && t.name !== t.code ? `${t.code}  ${t.name}` : t.code;
}

/** Column rows as one multi-line text: "◆" marks primary key columns. */
function tableLines(t: PdmTable): string {
  const pk = new Set(t.keys.find((k) => k.id === t.primaryKeyId)?.columnIds ?? []);
  const rows = t.columns.slice(0, MAX_ROWS).map((c) => `${pk.has(c.id) ? '◆' : ' '} ${c.code}  ${c.dataType}`);
  if (t.columns.length > MAX_ROWS) rows.push(`  … 另有 ${t.columns.length - MAX_ROWS} 个字段`);
  return rows.join('\n');
}

/** PowerDesigner point (y up) to canvas coordinates (y down). */
function toScreen([x, y]: [number, number]): { x: number; y: number } {
  return { x: x / PD_UNITS_PER_PX, y: -y / PD_UNITS_PER_PX };
}

/**
 * Anchor of a link end: where PowerDesigner attached it, relative to the
 * node center, kept inside the node (our nodes may be smaller than
 * PowerDesigner's symbols).
 */
function endAnchor(node: Node, point: [number, number] | undefined) {
  if (!point) return { name: 'center' };
  const box = node.getBBox();
  const p = toScreen(point);
  const c = box.getCenter();
  const clamp = (v: number, half: number) => Math.max(-half + 2, Math.min(half - 2, v));
  return { name: 'center', args: { dx: clamp(p.x - c.x, box.width / 2), dy: clamp(p.y - c.y, box.height / 2) } };
}

/** Which border of `box` a local point is near (within `band`), if any. */
function nearBorder(
  box: { x: number; y: number; width: number; height: number },
  p: { x: number; y: number },
  band: number,
): 'left' | 'right' | 'top' | 'bottom' | null {
  const d = {
    left: p.x - box.x,
    right: box.x + box.width - p.x,
    top: p.y - box.y,
    bottom: box.y + box.height - p.y,
  };
  const [side, dist] = Object.entries(d).sort((a, b) => a[1] - b[1])[0];
  return dist >= 0 && dist <= band ? (side as 'left' | 'right' | 'top' | 'bottom') : null;
}

/** Rotation of the "→" handle so it points out of the table's border. */
const HANDLE_ROTATION = { right: 0, bottom: 90, left: 180, top: 270 };

/**
 * ER view of one PowerDesigner diagram, positioned from the diagram's own
 * symbol rectangles. Node ids are the PDM symbol ids. The graph is rebuilt
 * only when the diagram changes; model edits update node labels in place.
 */
export function DiagramCanvas({
  model,
  diagram,
  selection,
  onSelect,
  tool,
  onToolChange,
  onPlaceTable,
  onMoveSymbols,
  onCreateReference,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  /** Arrow shown on a table border where a link can be dragged out (pointer tool). */
  const handleRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  // X6 handlers are registered once; refs give them the latest props.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const modelRef = useRef(model);
  modelRef.current = model;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const onToolChangeRef = useRef(onToolChange);
  onToolChangeRef.current = onToolChange;
  const onPlaceTableRef = useRef(onPlaceTable);
  onPlaceTableRef.current = onPlaceTable;
  const onMoveSymbolsRef = useRef(onMoveSymbols);
  onMoveSymbolsRef.current = onMoveSymbols;
  const onCreateReferenceRef = useRef(onCreateReference);
  onCreateReferenceRef.current = onCreateReference;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  /** Diagram the view was last fitted to; other redraws keep zoom and pan. */
  const fittedRef = useRef<string | null>(null);
  /** Pending zoom-to-fit frame; cancelled as soon as the user presses the mouse. */
  const fitFrameRef = useRef<number | null>(null);

  // Create the X6 graph once per mounted canvas.
  useEffect(() => {
    const host = hostRef.current!;
    /** Whether a link drag is in progress (blocks moving the table). */
    let linking = false;
    const graph = new Graph({
      container: host,
      // Synchronous rendering: with async views, clearing and re-adding cells with
      // the same ids in one tick leaves stale node views behind.
      async: false,
      autoResize: true,
      background: { color: C.canvasBg },
      grid: { visible: true, size: 10, type: 'dot', args: { color: C.grid } },
      // Drag the blank canvas to pan; Ctrl/Cmd + wheel to zoom.
      panning: { enabled: true },
      mousewheel: { enabled: true, modifiers: ['ctrl', 'meta'], minScale: 0.1, maxScale: 3 },
      // Tables can be dragged with the pointer tool, unless the press started a
      // link on the table's border. Links follow their tables and cannot be
      // dragged on their own (yet).
      interacting: () => ({
        nodeMovable: toolRef.current === 'select' && !linking,
        edgeMovable: false,
        edgeLabelMovable: false,
        arrowheadMovable: false,
        vertexMovable: false,
        vertexAddable: false,
        vertexDeletable: false,
      }),
    });
    graphRef.current = graph;

    // ----- Drawing a reference link -------------------------------------
    // PowerDesigner draws a reference by dragging from the child table to the
    // parent table: with the "关系" tool from anywhere on the table, or with
    // the pointer from the arrow that appears on a table's border.
    /** Clicks right after a link drag belong to it, not to selection. */
    let swallowClick = false;

    /** Table under a canvas point, ignoring the preview edge. */
    const nodeAt = (p: { x: number; y: number }): Node | undefined =>
      graph.getNodesFromPoint(p.x, p.y).find((n) => n.id !== PREVIEW_ID);

    /** Border highlight of a node: selected, link target, or plain. */
    const paint = (node: Node, target = false) => {
      const selected = node.getData().tableId === selectedTableId(selectionRef.current);
      node.attr('body/stroke', target || selected ? C.accent : C.nodeBorder);
      node.attr('body/strokeWidth', target || selected ? 2 : 1);
      node.attr('body/strokeDasharray', target ? '4 2' : null);
    };

    const startLink = (source: Node, e: { clientX: number; clientY: number }) => {
      linking = true;
      hideHandle();
      // X6 would pan the canvas on a press it does not use for moving a node.
      graph.disablePanning();
      let target: Node | undefined;
      // A self reference needs the pointer to leave the table and come back.
      let leftSource = false;
      const preview: Edge = graph.addEdge({
        id: PREVIEW_ID,
        source: { cell: source.id },
        target: graph.clientToLocal(e.clientX, e.clientY),
        zIndex: 1000,
        attrs: {
          line: {
            stroke: C.accent,
            strokeWidth: 1.5,
            strokeDasharray: '5 3',
            targetMarker: { name: 'classic', size: 7 },
          },
        },
      });
      const onMove = (ev: MouseEvent) => {
        const p = graph.clientToLocal(ev.clientX, ev.clientY);
        if (!source.getBBox().containsPoint(p)) leftSource = true;
        const over = nodeAt(p);
        const valid = over && (over !== source || leftSource) ? over : undefined;
        if (valid !== target) {
          if (target) paint(target);
          if (valid) paint(valid, true);
          target = valid;
        }
        // Snap onto a valid target table, otherwise follow the pointer.
        preview.setTarget(valid && valid !== source ? { cell: valid.id } : p);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        graph.enablePanning();
        linking = false;
        swallowClick = true;
        setTimeout(() => (swallowClick = false), 0);
        if (graph.getCellById(PREVIEW_ID)) graph.removeCell(PREVIEW_ID);
        if (target) paint(target);
        if (target) onCreateReferenceRef.current(source.id, target.id);
      };
      // Capture phase: X6 stops mouseup at the document, and fires its own
      // click from there; this runs first and marks that click as ours.
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
    };

    // Pointer tool: hovering near a table's border shows an arrow handle.
    let hot: Node | null = null;
    const hideHandle = () => {
      hot = null;
      if (handleRef.current) handleRef.current.style.display = 'none';
    };
    const onHover = (ev: MouseEvent) => {
      if (linking || ev.buttons !== 0 || toolRef.current !== 'select') return hideHandle();
      const p = graph.clientToLocal(ev.clientX, ev.clientY);
      const node = nodeAt(p);
      const side = node && nearBorder(node.getBBox(), p, EDGE_BAND / graph.zoom());
      const handle = handleRef.current;
      if (!node || !side || !handle) return hideHandle();
      hot = node;
      const wrap = host.getBoundingClientRect();
      handle.style.display = 'flex';
      handle.style.left = `${ev.clientX - wrap.left}px`;
      handle.style.top = `${ev.clientY - wrap.top}px`;
      handle.style.transform = `translate(-50%, -50%) rotate(${HANDLE_ROTATION[side]}deg)`;
    };
    host.addEventListener('mousemove', onHover);
    host.addEventListener('mouseleave', hideHandle);

    graph.on('node:mousedown', ({ node, e }) => {
      if (e.button !== 0) return;
      // Decided before X6 checks `nodeMovable`, so the table does not move.
      if (toolRef.current === 'reference' || (toolRef.current === 'select' && hot === node)) startLink(node, e);
    });

    graph.on('node:click', ({ node }) => {
      if (swallowClick) return;
      onSelectRef.current({ type: 'table', tableId: node.getData().tableId });
    });
    graph.on('edge:click', ({ edge }) => {
      if (swallowClick || edge.id === PREVIEW_ID) return;
      onSelectRef.current({ type: 'reference', referenceId: edge.getData().referenceId });
    });
    graph.on('blank:click', ({ x, y }) => {
      if (swallowClick) return;
      // Table tool: create a table where the user clicked. The tool stays
      // active for more tables, as in PowerDesigner.
      if (toolRef.current === 'table') {
        onPlaceTableRef.current({ x: x * PD_UNITS_PER_PX, y: -y * PD_UNITS_PER_PX });
      } else {
        onSelectRef.current(null);
      }
    });
    // A finished drag becomes one undoable move, measured from where the node
    // was when the drag started. Screen y points down, PowerDesigner's y up.
    const dragStart = new Map<string, { x: number; y: number }>();
    graph.on('node:move', ({ node }) => dragStart.set(node.id, node.getPosition()));
    graph.on('node:moved', ({ node }) => {
      const start = dragStart.get(node.id);
      dragStart.delete(node.id);
      if (!start) return;
      const { x: x0, y: y0 } = start;
      const { x, y } = node.getPosition();
      const dx = Math.round((x - x0) * PD_UNITS_PER_PX);
      const dy = Math.round(-(y - y0) * PD_UNITS_PER_PX);
      if (dx !== 0 || dy !== 0) onMoveSymbolsRef.current([{ symbolId: node.id, dx, dy }]);
      // Dragging a table also selects it, as in PowerDesigner.
      onSelectRef.current({ type: 'table', tableId: node.getData().tableId });
    });
    // A late zoom-to-fit (e.g. on a slow first start) must not shift the view
    // under a drag that has already begun.
    const cancelFit = () => {
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = null;
    };
    graph.on('node:mousedown', cancelFit);
    graph.on('blank:mousedown', cancelFit);
    // Right-click returns to the pointer, like PowerDesigner.
    graph.on('blank:contextmenu', () => onToolChangeRef.current('select'));
    return () => {
      host.removeEventListener('mousemove', onHover);
      host.removeEventListener('mouseleave', hideHandle);
      graph.dispose();
      graphRef.current = null;
    };
  }, []);

  // Redraw all nodes and edges when the diagram or the model changes
  // (synchronous and fast enough for hundreds of tables).
  useEffect(() => {
    const graph = graphRef.current!;
    const tables = new Map(model.tables.map((t) => [t.id, t]));
    graph.clearCells();

    for (const s of diagram.tableSymbols) {
      const t = tables.get(s.tableId);
      // Skip symbols whose table is missing or that have no position.
      if (!t || !s.rect) continue;
      const rows = Math.min(t.columns.length, MAX_ROWS) + (t.columns.length > MAX_ROWS ? 1 : 0);
      // Width follows the PowerDesigner symbol, clamped to stay readable.
      const width = Math.max(200, Math.min(420, (s.rect.x2 - s.rect.x1) / PD_UNITS_PER_PX));
      const height = HEADER_H + Math.max(1, rows) * ROW_H + 8;
      // Center on the PowerDesigner symbol; its y axis points up, the screen's points down.
      const cx = (s.rect.x1 + s.rect.x2) / 2 / PD_UNITS_PER_PX;
      const cy = -(s.rect.y1 + s.rect.y2) / 2 / PD_UNITS_PER_PX;
      graph.addNode({
        id: s.id,
        x: cx - width / 2,
        y: cy - height / 2,
        width,
        height,
        data: { tableId: t.id },
        markup: [
          { tagName: 'rect', selector: 'body' },
          { tagName: 'rect', selector: 'header' },
          { tagName: 'text', selector: 'title' },
          { tagName: 'text', selector: 'rows' },
        ],
        attrs: {
          body: {
            refWidth: '100%',
            refHeight: '100%',
            fill: C.nodeBg,
            stroke: C.nodeBorder,
            strokeWidth: 1,
            rx: 4,
            ry: 4,
          },
          header: {
            refWidth: '100%',
            height: HEADER_H,
            fill: C.nodeHeader,
            stroke: C.nodeBorder,
            strokeWidth: 1,
            rx: 4,
            ry: 4,
          },
          title: {
            text: tableTitle(t),
            refX: 10,
            refY: HEADER_H / 2,
            textAnchor: 'start',
            textVerticalAnchor: 'middle',
            fontSize: 12,
            fontWeight: 600,
            fill: C.nodeTitle,
          },
          rows: {
            text: tableLines(t),
            refX: 8,
            refY: HEADER_H + 6,
            textAnchor: 'start',
            textVerticalAnchor: 'top',
            fontSize: 11,
            lineHeight: ROW_H,
            fontFamily: C.mono,
            fill: C.nodeText,
            xmlSpace: 'preserve',
          },
        },
      });
    }

    // References are drawn as edges from the child table to the parent table,
    // along the link's stored points: its ends where PowerDesigner attached
    // them, its bends as vertices (a self reference is a loop of bends).
    for (const rs of diagram.referenceSymbols) {
      if (!rs.sourceSymbolId || !rs.destinationSymbolId) continue;
      const src = graph.getCellById(rs.sourceSymbolId);
      const dst = graph.getCellById(rs.destinationSymbolId);
      if (!src?.isNode() || !dst?.isNode()) continue;
      graph.addEdge({
        id: rs.id,
        source: { cell: rs.sourceSymbolId, anchor: endAnchor(src, rs.points[0]) },
        target: { cell: rs.destinationSymbolId, anchor: endAnchor(dst, rs.points[rs.points.length - 1]) },
        vertices: rs.points.slice(1, -1).map(toScreen),
        data: { referenceId: rs.referenceId },
        connector: { name: 'rounded' },
        attrs: {
          line: { stroke: C.edge, strokeWidth: 1.4, targetMarker: { name: 'classic', size: 7 } },
        },
      });
    }

    // Fit only when a diagram is first shown; edits keep the user's zoom.
    // An empty diagram counts as fitted too, or placing its first table
    // would re-fit the view and the table would jump away from the click.
    if (fittedRef.current === diagram.id) return;
    fittedRef.current = diagram.id;
    // Wait for layout so the container has its real size before fitting.
    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null;
      if (graph.getNodes().length) graph.zoomToFit({ padding: 40, maxScale: 1 });
    });
    return () => {
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = null;
    };
  }, [diagram, model]);

  // Highlight the selected table or reference and scroll it into view.
  useEffect(() => {
    const graph = graphRef.current!;
    const tableId = selectedTableId(selection);
    const refId = selection?.type === 'reference' ? selection.referenceId : null;
    for (const node of graph.getNodes()) {
      const on = node.getData().tableId === tableId;
      node.attr('body/stroke', on ? C.accent : C.nodeBorder);
      node.attr('body/strokeWidth', on ? 2 : 1);
      if (on && !graph.getGraphArea().containsRect(node.getBBox())) graph.centerCell(node);
    }
    for (const edge of graph.getEdges()) {
      const on = edge.getData().referenceId === refId;
      edge.attr('line/stroke', on ? C.accent : C.edge);
      edge.attr('line/strokeWidth', on ? 2.4 : 1.4);
    }
    // Redraws reset the highlight, so re-apply it after model changes too.
  }, [selection, diagram, model]);

  return (
    <div className={`canvas-wrap tool-${tool}`}>
      <div ref={hostRef} className="canvas-host" />
      {/* Arrow handle on a table border (pointer tool): drag it to another table. */}
      <div ref={handleRef} className="link-handle">
        <ArrowRightOutlined />
      </div>
      {/* Palette: pointer, table, and reference tools (Esc or right-click returns to the pointer). */}
      <div className="palette">
        <Tooltip title="指针（Esc）" placement="right">
          <Button
            size="small"
            type={tool === 'select' ? 'primary' : 'text'}
            icon={<SelectOutlined />}
            onClick={() => onToolChange('select')}
          />
        </Tooltip>
        <Tooltip title="表：在画布上单击新建表" placement="right">
          <Button
            size="small"
            type={tool === 'table' ? 'primary' : 'text'}
            icon={<TableOutlined />}
            onClick={() => onToolChange('table')}
          />
        </Tooltip>
        <Tooltip title="关系（外键）：从子表拖到父表" placement="right">
          <Button
            size="small"
            type={tool === 'reference' ? 'primary' : 'text'}
            icon={<NodeIndexOutlined />}
            onClick={() => onToolChange('reference')}
          />
        </Tooltip>
      </div>
      {/* Hint over the canvas when the diagram has no tables yet. */}
      {diagram.tableSymbols.length === 0 && (
        <Empty
          className="canvas-empty overlay"
          description="此关系图中没有表。选择左上角的「表」工具，在画布上单击即可新建表"
        />
      )}
    </div>
  );
}
