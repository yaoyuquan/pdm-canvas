import { useEffect, useRef } from 'react';
import { Empty } from 'antd';
import { Graph } from '@antv/x6';
import type { PdmDiagram, PdmModel, PdmTable } from '../../pdm/types';
import { selectedTableId, type Selection } from '../selection';

interface Props {
  model: PdmModel;
  diagram: PdmDiagram;
  selection: Selection;
  onSelect: (sel: Selection) => void;
}

/** PowerDesigner model units per screen pixel at 100% zoom. */
const PD_UNITS_PER_PX = 50;
const HEADER_H = 26;
const ROW_H = 18;
const MAX_ROWS = 14;

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

function tableTitle(t: PdmTable): string {
  return t.name && t.name !== t.code ? `${t.code}  ${t.name}` : t.code;
}

function tableLines(t: PdmTable): string {
  const pk = new Set(t.keys.find((k) => k.id === t.primaryKeyId)?.columnIds ?? []);
  const rows = t.columns.slice(0, MAX_ROWS).map((c) => `${pk.has(c.id) ? '◆' : ' '} ${c.code}  ${c.dataType}`);
  if (t.columns.length > MAX_ROWS) rows.push(`  … 另有 ${t.columns.length - MAX_ROWS} 个字段`);
  return rows.join('\n');
}

/**
 * ER view of one PowerDesigner diagram, positioned from the diagram's own
 * symbol rectangles. Node ids are the PDM symbol ids. The graph is rebuilt
 * only when the diagram changes; model edits update node labels in place.
 */
export function DiagramCanvas({ model, diagram, selection, onSelect }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const modelRef = useRef(model);
  modelRef.current = model;

  useEffect(() => {
    const host = hostRef.current!;
    const graph = new Graph({
      container: host,
      // Synchronous rendering: with async views, clearing and re-adding cells with
      // the same ids in one tick leaves stale node views behind.
      async: false,
      autoResize: true,
      background: { color: C.canvasBg },
      grid: { visible: true, size: 10, type: 'dot', args: { color: C.grid } },
      panning: { enabled: true },
      mousewheel: { enabled: true, modifiers: ['ctrl', 'meta'], minScale: 0.1, maxScale: 3 },
      interacting: { nodeMovable: false },
    });
    graphRef.current = graph;
    graph.on('node:click', ({ node }) => onSelectRef.current({ type: 'table', tableId: node.getData().tableId }));
    graph.on('edge:click', ({ edge }) =>
      onSelectRef.current({ type: 'reference', referenceId: edge.getData().referenceId }),
    );
    graph.on('blank:click', () => onSelectRef.current(null));
    return () => {
      graph.dispose();
      graphRef.current = null;
    };
  }, []);

  useEffect(() => {
    const graph = graphRef.current!;
    const tables = new Map(modelRef.current.tables.map((t) => [t.id, t]));
    graph.clearCells();

    for (const s of diagram.tableSymbols) {
      const t = tables.get(s.tableId);
      if (!t || !s.rect) continue;
      const rows = Math.min(t.columns.length, MAX_ROWS) + (t.columns.length > MAX_ROWS ? 1 : 0);
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

    for (const rs of diagram.referenceSymbols) {
      if (!rs.sourceSymbolId || !rs.destinationSymbolId) continue;
      if (!graph.getCellById(rs.sourceSymbolId) || !graph.getCellById(rs.destinationSymbolId)) continue;
      graph.addEdge({
        id: rs.id,
        source: { cell: rs.sourceSymbolId },
        target: { cell: rs.destinationSymbolId },
        data: { referenceId: rs.referenceId },
        connector: { name: 'rounded' },
        attrs: {
          line: { stroke: C.edge, strokeWidth: 1.4, targetMarker: { name: 'classic', size: 7 } },
        },
      });
    }

    // Wait for layout so the container has its real size before fitting.
    const raf = requestAnimationFrame(() => {
      if (graph.getNodes().length) graph.zoomToFit({ padding: 40, maxScale: 1 });
    });
    return () => cancelAnimationFrame(raf);
  }, [diagram]);

  useEffect(() => {
    const graph = graphRef.current!;
    const tables = new Map(model.tables.map((t) => [t.id, t]));
    for (const node of graph.getNodes()) {
      const t = tables.get(node.getData().tableId);
      if (!t) continue;
      const title = tableTitle(t);
      const rows = tableLines(t);
      if (node.attr('title/text') !== title) node.attr('title/text', title);
      if (node.attr('rows/text') !== rows) node.attr('rows/text', rows);
    }
  }, [model]);

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
  }, [selection, diagram]);

  return (
    <div className="canvas-wrap">
      <div ref={hostRef} className="canvas-host" />
      {diagram.tableSymbols.length === 0 && <Empty className="canvas-empty overlay" description="此关系图中没有表" />}
    </div>
  );
}
