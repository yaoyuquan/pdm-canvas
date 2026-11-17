/**
 * Minimal offset-tracking XML scanner for PowerDesigner files.
 *
 * Unlike a DOM parser, it never re-serializes: every element records its
 * byte-independent string offsets in the original source so callers can
 * splice edits into the untouched text (see `patch.ts`). This keeps CRLF
 * line endings, entity spellings (`&quot;`), and all unknown content
 * exactly as PowerDesigner wrote them.
 */

export interface XElement {
  name: string;
  attrs: Record<string, string>;
  /** Offset of `<` of the start tag. */
  start: number;
  /** Offset just past `>` of the start tag (equals `end` when self-closing). */
  openEnd: number;
  /** Offset of `<` of the end tag (equals `end` when self-closing). */
  closeStart: number;
  /** Offset just past `>` of the end tag (or of the self-closing tag). */
  end: number;
  selfClosing: boolean;
  parent: XElement | null;
  children: XElement[];
}

export interface XmlDocument {
  source: string;
  /** Line terminator used by the file (`\r\n` for PowerDesigner on Windows). */
  eol: string;
  /** Raw content of `<?PowerDesigner ...?>` processing instruction attributes. */
  piAttrs: Record<string, string>;
  root: XElement;
}

export class XmlParseError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} (at offset ${offset})`);
    this.name = 'XmlParseError';
  }
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) {
    attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
  }
  return attrs;
}

export function parseXml(source: string): XmlDocument {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  let piAttrs: Record<string, string> = {};
  let root: XElement | null = null;
  const stack: XElement[] = [];
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = source.length;

  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt < 0) break;
    i = lt;

    if (source.startsWith('<?', i)) {
      const close = source.indexOf('?>', i + 2);
      if (close < 0) throw new XmlParseError('Unterminated processing instruction', i);
      const body = source.slice(i + 2, close);
      const target = /^\S+/.exec(body)?.[0] ?? '';
      if (target === 'PowerDesigner') piAttrs = parseAttrs(body.slice(target.length));
      i = close + 2;
    } else if (source.startsWith('<!--', i)) {
      const close = source.indexOf('-->', i + 4);
      if (close < 0) throw new XmlParseError('Unterminated comment', i);
      i = close + 3;
    } else if (source.startsWith('<![CDATA[', i)) {
      const close = source.indexOf(']]>', i + 9);
      if (close < 0) throw new XmlParseError('Unterminated CDATA section', i);
      i = close + 3;
    } else if (source.startsWith('<!', i)) {
      const close = source.indexOf('>', i + 2);
      if (close < 0) throw new XmlParseError('Unterminated declaration', i);
      i = close + 1;
    } else if (source.startsWith('</', i)) {
      const close = source.indexOf('>', i + 2);
      if (close < 0) throw new XmlParseError('Unterminated end tag', i);
      const name = source.slice(i + 2, close).trim();
      const el = stack.pop();
      if (!el || el.name !== name) {
        throw new XmlParseError(`Unexpected </${name}>, expected </${el?.name ?? '(none)'}>`, i);
      }
      el.closeStart = i;
      el.end = close + 1;
      i = close + 1;
    } else {
      const close = findTagEnd(source, i + 1);
      if (close < 0) throw new XmlParseError('Unterminated start tag', i);
      const selfClosing = source.charCodeAt(close - 1) === 47; /* '/' */
      const inner = source.slice(i + 1, selfClosing ? close - 1 : close);
      const name = /^[^\s/>]+/.exec(inner)?.[0];
      if (!name) throw new XmlParseError('Missing element name', i);
      const parent = stack[stack.length - 1] ?? null;
      const el: XElement = {
        name,
        attrs: parseAttrs(inner.slice(name.length)),
        start: i,
        openEnd: close + 1,
        closeStart: close + 1,
        end: close + 1,
        selfClosing,
        parent,
        children: [],
      };
      if (parent) parent.children.push(el);
      else if (root) throw new XmlParseError('Multiple root elements', i);
      else root = el;
      if (!selfClosing) stack.push(el);
      i = close + 1;
    }
  }

  if (stack.length) throw new XmlParseError(`Unclosed <${stack[stack.length - 1].name}>`, n);
  if (!root) throw new XmlParseError('No root element', 0);
  return { source, eol, piAttrs, root };
}

/** Finds the `>` closing a start tag, skipping quoted attribute values. */
function findTagEnd(s: string, from: number): number {
  let quote = 0;
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62) {
      return j;
    }
  }
  return -1;
}

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    switch (e) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    }
  });
}

/** Escapes text content the way PowerDesigner does (it also escapes `"`). */
export function encodeText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

/** Decoded text content of a leaf element (line endings normalized to `\n`). */
export function textOf(doc: XmlDocument, el: XElement): string {
  if (el.selfClosing) return '';
  const raw = doc.source.slice(el.openEnd, el.closeStart);
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(raw);
  return (cdata ? cdata[1] : decodeEntities(raw)).replace(/\r\n/g, '\n');
}

export function childEl(el: XElement, name: string): XElement | undefined {
  return el.children.find((c) => c.name === name);
}

export function childEls(el: XElement, name: string): XElement[] {
  return el.children.filter((c) => c.name === name);
}
