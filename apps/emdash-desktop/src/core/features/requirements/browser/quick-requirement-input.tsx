import { Textarea } from '@emdash/ui/react/primitives';
import { useState } from 'react';
import { splitQuickEntry } from '../api/quick-entry';

/**
 * One line to note a requirement: Enter adds it (the first line is the title, the rest
 * its detail) and clears the box for the next one; Shift+Enter starts a new line.
 */
export function QuickRequirementInput({
  onAdd,
  autoFocus,
}: {
  onAdd: (entry: { title: string; detail?: string }) => Promise<unknown>;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const entry = splitQuickEntry(text);
    if (!entry) return;
    setBusy(true);
    try {
      await onAdd(entry);
      setText('');
    } catch {
      // The hook already told the user; keep the text so nothing is lost.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Textarea
      value={text}
      rows={2}
      autoFocus={autoFocus}
      disabled={busy}
      placeholder="Note a requirement… (Enter to add, Shift+Enter for a new line)"
      aria-label="Note a requirement"
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        // An input method confirms its candidate with Enter; that is not a submit.
        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        void submit();
      }}
    />
  );
}
