import { useEffect, useState } from 'react';
import { Input, Typography } from 'antd';
import type { Issue } from '../../editing/validate';

interface Props {
  label: string;
  /** Current value in the model. */
  value: string;
  /** Text area instead of a single-line input (e.g. comments). */
  multiline?: boolean;
  /** Monospace font for codes and data types. */
  mono?: boolean;
  placeholder?: string;
  /** Returns an error (blocks commit) or a warning (shown only), or null. */
  validate: (value: string) => Issue | null;
  /** Called with the new value once the user finishes editing. */
  onCommit: (value: string) => void;
}

/**
 * A property input that commits on blur / Enter (Ctrl+Enter for multi-line)
 * and reverts on Escape. Errors block the commit; warnings are shown only.
 */
export function EditableField({ label, value, multiline, mono, placeholder, validate, onCommit }: Props) {
  // What the user is typing; only committed on blur/Enter.
  const [draft, setDraft] = useState(value);
  // Result of the last commit attempt.
  const [issue, setIssue] = useState<Issue | null>(null);

  // External changes (undo/redo, another object selected) replace the draft.
  useEffect(() => {
    setDraft(value);
    setIssue(null);
  }, [value]);

  /** Validates the draft and hands it to onCommit unless it has an error. */
  const commit = () => {
    // Unchanged: nothing to commit, and clear an earlier error.
    if (draft === value) {
      setIssue(null);
      return;
    }
    const found = validate(draft);
    setIssue(found);
    if (found?.level !== 'error') onCommit(draft);
  };

  /** Escape: drop the draft and leave the field. */
  const revert = (el: HTMLElement) => {
    setDraft(value);
    setIssue(null);
    // Let the reset render first, so blur doesn't commit the old draft.
    setTimeout(() => el.blur(), 0);
  };

  // Show the commit result, or else warnings about the stored value itself
  // (e.g. an over-long code imported from the file).
  const shown = issue ?? (draft === value ? validate(value) : null);
  // Props shared by the single-line and multi-line inputs.
  const common = {
    value: draft,
    placeholder,
    status: shown ? shown.level : undefined,
    className: mono ? 'mono' : undefined,
    onBlur: commit,
  } as const;

  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {multiline ? (
        <Input.TextArea
          {...common}
          autoSize={{ minRows: 2, maxRows: 8 }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') revert(e.currentTarget);
            else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.blur();
          }}
        />
      ) : (
        <Input
          {...common}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') revert(e.currentTarget);
            else if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      )}
      {shown && (
        <Typography.Text type={shown.level === 'error' ? 'danger' : 'warning'} className="field-issue">
          {shown.message}
        </Typography.Text>
      )}
    </div>
  );
}
