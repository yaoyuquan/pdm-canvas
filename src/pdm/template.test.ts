import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DBMS_OPTIONS, instantiateTemplate, readPdm } from './index';

/**
 * Tests for the blank templates and for creating new models from them.
 * The templates were saved by PowerDesigner 16.7.5; these tests guard against
 * them being edited or re-encoded by accident (e.g. CRLF -> LF by git).
 */
const TEMPLATES = path.resolve(__dirname, '../../resources/templates');
const GUID = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g;

// Predictable GUIDs so assertions can tell new ones from template ones.
let counter = 0;
const fakeGuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const now = new Date('2026-11-20T08:00:00Z');
const stamp = String(now.getTime() / 1000);

describe.each(DBMS_OPTIONS)('template $kind', ({ label, template }) => {
  const src = fs.readFileSync(path.join(TEMPLATES, template), 'utf8');
  const tpl = readPdm(src);

  it('is an empty PowerDesigner model for its DBMS', () => {
    expect(tpl.model.target).toBe(label);
    expect(tpl.model.pdVersion).toBe('16.7.5.6978');
    expect(tpl.model.tables).toEqual([]);
    expect(tpl.model.diagrams).toHaveLength(1);
    // PowerDesigner writes CRLF only; a bare LF means the file was altered.
    expect(src).toContain('\r\n');
    expect(src).not.toMatch(/[^\r]\n/);
    // The local path where the template was generated must not ship.
    expect(src).not.toContain('RepositoryFilename');
  });

  it('instantiates with fresh identity and nothing else changed', () => {
    const out = instantiateTemplate(src, { user: 'Zhang <S>', now, newGuid: fakeGuid });
    const m = readPdm(out).model;
    expect(m.target).toBe(label);
    // The model GUID is new, and the file header carries the same one.
    expect(m.objectId).toMatch(/^00000000-0000-4000-8000-/);
    expect(out).toContain(`ID="{${m.objectId}}"`);
    expect(out).toContain(`LastModificationDate="${stamp}"`);
    // The user name is XML-escaped.
    expect(out).toContain('<a:Creator>Zhang &lt;S&gt;</a:Creator>');

    // Template-own GUIDs are all replaced; DBMS/class GUIDs are kept.
    const oldIds = [...src.matchAll(/<a:ObjectID>([^<]+)</g)].map((x) => x[1]);
    for (const id of oldIds) expect(out).not.toContain(id);
    const targetId = /<a:TargetID>([^<]+)</.exec(src)![1];
    expect(out).toContain(`<a:TargetID>${targetId}</a:TargetID>`);
    expect(out).toContain(`<a:TargetModelID>${targetId}</a:TargetModelID>`);

    // Masking identity fields yields the template, byte for byte.
    const mask = (s: string) =>
      s
        .replace(GUID, 'G')
        .replace(/(Date>|Date=")\d+/g, '$1D')
        .replace(/<a:(Creator|Modifier)>[^<]*</g, '<a:$1>U<');
    expect(mask(out)).toBe(mask(src));
  });

  it('gives each instance distinct GUIDs', () => {
    const a = readPdm(instantiateTemplate(src, { user: 'u', now, newGuid: fakeGuid })).model;
    const b = readPdm(instantiateTemplate(src, { user: 'u', now, newGuid: fakeGuid })).model;
    expect(a.objectId).not.toBe(b.objectId);
  });
});
