import { useEffect, useState } from 'react';
import { Input, Typography } from 'antd';
import type { Issue } from '../../editing/validate';

interface Props {
  label: string;
  value: string;
  multiline?: boolean;
  mono?: boolean;
  placeholder?: string;
  validate: (value: string) => Issue | null;
  onCommit: (value: string) => void;
}

/**
 * A property input that commits on blur / Enter (Ctrl+Enter for multi-line)
 * and reverts on Escape. Errors block the commit; warnings are shown only.
 */
export function EditableField({ label, value, multiline, mono, placeholder, validate, onCommit }: Props) {
  const [draft, setDraft] = useState(value);
  const [issue, setIssue] = useState<Issue | null>(null);

  // External changes (undo/redo, another object selected) replace the draft.
  useEffect(() => {
    setDraft(value);
    setIssue(null);
  }, [value]);

  const commit = () => {
    if (draft === value) {
      setIssue(null);
      return;
    }
    const found = validate(draft);
    setIssue(found);
    if (found?.level !== 'error') onCommit(draft);
  };

  const revert = (el: HTMLElement) => {
    setDraft(value);
    setIssue(null);
    // Let the reset render first, so blur doesn't commit the old draft.
    setTimeout(() => el.blur(), 0);
  };

  const shown = issue ?? (draft === value ? validate(value) : null);
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
