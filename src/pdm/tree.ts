/**
 * Patch tree: a mutable view over the parsed XML used to write structural
 * changes (insert, delete, reorder elements) without regenerating the file.
 *
 * Every node wraps either an original element (with its offsets) or a new
 * fragment of XML text. Serializing copies untouched original elements as
 * exact slices of the source; only nodes whose content changed are stitched
 * back together from the original text between their children plus the
 * changed children. So everything the user did not edit stays byte-identical
 * (CLAUDE.md rule 1), and nested changes compose without offset bookkeeping.
 */
import { encodeText, type XElement, type XmlDocument } from './xml';

/** Thrown when a change cannot be applied safely; nothing is written then. */
export class PdmTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdmTreeError';
  }
}

export class PNode {
  /** Child list, materialized from the original element on first change. */
  private kids: PNode[] | null = null;
  /** New text content (decoded) for a leaf element, if replaced. */
  private newText: string | null = null;

  private constructor(
    readonly tree: PatchTree,
    /** Original element; absent for nodes created from new XML text. */
    readonly el: XElement | null,
    /** Full XML text of a new node (already using the file's line endings). */
    private readonly raw: string | null,
    /** Element name, e.g. `o:Table`, `c:Columns`, `a:Name`. */
    readonly name: string,
    /** `Id` or `Ref` attribute, if any. */
    readonly id: string | undefined,
    readonly ref: string | undefined,
  ) {}

  /** @internal Wraps an original element. */
  static fromElement(tree: PatchTree, el: XElement): PNode {
    return new PNode(tree, el, null, el.name, el.attrs.Id, el.attrs.Ref);
  }

  /** @internal Wraps new XML text; its name and Id/Ref are read from the start tag. */
  static fromXml(tree: PatchTree, xml: string): PNode {
    const m = /^<([^\s/>]+)([^>]*)>/.exec(xml);
    if (!m) throw new PdmTreeError(`Invalid XML fragment: ${xml.slice(0, 40)}`);
    const id = /\sId="([^"]+)"/.exec(m[2])?.[1];
    const ref = /\sRef="([^"]+)"/.exec(m[2])?.[1];
    return new PNode(tree, null, xml, m[1], id, ref);
  }

  /** True when this node was created by the writer rather than read from the file. */
  get isNew(): boolean {
    return this.el === null;
  }

  /** Child nodes (materializes them; read-only use does not mark the node changed). */
  children(): readonly PNode[] {
    if (this.kids) return this.kids;
    // New fragments are opaque: the writer never edits inside them.
    if (!this.el) return [];
    return this.el.children.map((c) => this.tree.wrap(c));
  }

  /** Mutable child list; from now on this node is serialized from its children. */
  private mutableKids(): PNode[] {
    if (!this.el) throw new PdmTreeError(`Cannot edit inside new element <${this.name}>`);
    if (!this.kids) {
      this.kids = this.el.children.map((c) => this.tree.wrap(c));
      this.touchAncestors();
    }
    return this.kids;
  }

  /**
   * Makes every ancestor serialize from its children, so this node's change
   * reaches the output. Rebuilding an unchanged element from its children
   * yields exactly its original bytes.
   */
  private touchAncestors(): void {
    for (let p = this.el?.parent; p; p = p.parent) {
      const node = this.tree.wrap(p);
      if (node.kids) break;
      node.kids = p.children.map((c) => this.tree.wrap(c));
    }
  }

  child(name: string): PNode | undefined {
    return this.children().find((c) => c.name === name);
  }

  /** Replaces the text content of a leaf element such as `<a:Name>`. */
  setText(value: string): void {
    if (!this.el) throw new PdmTreeError(`Cannot edit new element <${this.name}>`);
    this.newText = value;
    this.touchAncestors();
  }

  /** Removes a direct child (with the line break before it). */
  remove(child: PNode): void {
    const kids = this.mutableKids();
    const i = kids.indexOf(child);
    if (i < 0) throw new PdmTreeError(`<${child.name}> is not a child of <${this.name}>`);
    kids.splice(i, 1);
  }

  /** Inserts a child at the given position (default: at the end). */
  insert(child: PNode, index?: number): void {
    const kids = this.mutableKids();
    kids.splice(index ?? kids.length, 0, child);
  }

  /** Replaces all children, e.g. to reorder columns or rewrite a ref list. */
  setChildren(children: PNode[]): void {
    this.mutableKids();
    this.kids = [...children];
  }

  /**
   * Inserts `child` after the last existing child whose name comes before it
   * in `order` (PowerDesigner's element order); first if there is none. Names
   * not listed in `order` are skipped over, so unknown content stays in place.
   */
  insertOrdered(child: PNode, order: readonly string[]): void {
    const kids = this.mutableKids();
    const pos = order.indexOf(child.name);
    if (pos < 0) throw new PdmTreeError(`<${child.name}> has no known position`);
    const before = new Set(order.slice(0, pos));
    let at = 0;
    kids.forEach((k, i) => {
      // Attributes always precede collections; an unknown `a:` element counts as "before".
      if (before.has(k.name) || (k.name.startsWith('a:') && !order.includes(k.name))) at = i + 1;
    });
    kids.splice(at, 0, child);
  }

  /** Whether serializing needs more than a slice of the original source. */
  get changed(): boolean {
    return this.kids !== null || this.newText !== null;
  }

  /** XML text of this node. */
  serialize(): string {
    const { source, eol } = this.tree.xml;
    if (!this.el) return this.raw!;
    const el = this.el;

    if (this.newText !== null) {
      const text = encodeText(this.newText.replace(/\r?\n/g, eol));
      return `<${this.name}>${text}</${this.name}>`;
    }
    if (!this.kids) return source.slice(el.start, el.end);

    // Rebuild from children, keeping each original child's own leading gap
    // (always a line break in PowerDesigner files) and the original tail.
    let out = source.slice(el.start, el.openEnd);
    for (const k of this.kids) {
      // PowerDesigner never writes empty collections; drop them.
      if (k.name.startsWith('c:') && k.isEmptyCollection()) continue;
      out += k.leadingGap() + k.serialize();
    }
    if (el.children.length > 0) {
      const last = el.children[el.children.length - 1];
      out += source.slice(last.end, el.end);
    } else {
      out += eol + source.slice(el.closeStart, el.end);
    }
    return out;
  }

  /** @internal True for a changed collection whose children were all removed. */
  isEmptyCollection(): boolean {
    return this.kids !== null && this.kids.length === 0;
  }

  /** @internal Whitespace written before this node inside its parent. */
  leadingGap(): string {
    const { source, eol } = this.tree.xml;
    if (!this.el || !this.el.parent) return eol;
    const siblings = this.el.parent.children;
    const i = siblings.indexOf(this.el);
    const prevEnd = i > 0 ? siblings[i - 1].end : this.el.parent.openEnd;
    return source.slice(prevEnd, this.el.start);
  }
}

/** Patch tree over one parsed document. */
export class PatchTree {
  private readonly nodes = new Map<XElement, PNode>();
  readonly root: PNode;

  /**
   * @param xml Parsed document.
   * @param ids Index of original elements by `Id` (from `readPdm`).
   */
  constructor(
    readonly xml: XmlDocument,
    private readonly ids: ReadonlyMap<string, XElement>,
  ) {
    this.root = this.wrap(xml.root);
  }

  /** @internal One node per original element, so changes are never lost. */
  wrap(el: XElement): PNode {
    let n = this.nodes.get(el);
    if (!n) {
      n = PNode.fromElement(this, el);
      this.nodes.set(el, n);
    }
    return n;
  }

  /** Node for the object with the given `Id`. */
  byId(id: string): PNode | undefined {
    const el = this.ids.get(id);
    return el ? this.wrap(el) : undefined;
  }

  /** New node from XML text (lines joined with the file's line ending). */
  fragment(lines: string[]): PNode {
    return PNode.fromXml(this, lines.join(this.xml.eol));
  }

  /** The whole document: original prolog + serialized root + original epilog. */
  serialize(): string {
    const { source, root } = this.xml;
    return source.slice(0, root.start) + this.root.serialize() + source.slice(root.end);
  }

  /** Visits every node in document order (descending into changed child lists). */
  walk(fn: (node: PNode, parent: PNode | null) => void): void {
    const visit = (n: PNode, parent: PNode | null) => {
      fn(n, parent);
      for (const c of n.children()) visit(c, n);
    };
    visit(this.root, null);
  }
}
