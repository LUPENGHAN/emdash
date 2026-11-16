import { Button, Select } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getSourceControlClient } from '@core/features/source-control/api/browser/client';
import { sourceControlContract } from '@core/features/source-control/api/contract';
import { runDesktopLiveJob } from '@core/primitives/wire/browser/run-live-job';
import { getCoordinationClient } from '../api/browser/client';
import type { Coordinator } from '../api/types';

export function CoordinatorDocumentPush({
  record,
  revision,
  refresh,
  disabled = false,
}: {
  record: Coordinator;
  revision: string;
  refresh: () => Promise<unknown>;
  disabled?: boolean;
}) {
  const [selection, setSelection] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [receipt, setReceipt] = useState<{ oid: string; destination: string }>();
  const options = useQuery({
    queryKey: ['coordinator-document-remotes', record.id],
    queryFn: async () => (await getCoordinationClient()).documentPushOptions({ id: record.id }),
  });
  const saved = record.documentPushTarget;
  const value = selection ?? (saved ? `remote:${saved.remote}` : 'local');
  const selected = options.data?.targets.find((target) => `remote:${target.remote}` === value);
  const changed =
    value === 'local'
      ? !!saved
      : selected?.remote !== saved?.remote || selected?.fingerprint !== saved?.fingerprint;
  const configure = async () => {
    if (disabled || busy || (value !== 'local' && !selected)) return;
    setBusy(true);
    setError(undefined);
    setReceipt(undefined);
    try {
      const client = await getCoordinationClient();
      if (value === 'local') await client.configureDocumentPush({ id: record.id, remote: null });
      else if (selected)
        await client.configureDocumentPush({
          id: record.id,
          remote: selected.remote,
          expectedFingerprint: selected.fingerprint,
        });
      setSelection(undefined);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const push = async () => {
    if (disabled || busy || !saved) return;
    setBusy(true);
    setError(undefined);
    setReceipt(undefined);
    try {
      const plan = await (
        await getCoordinationClient()
      ).prepareDocumentPush({
        id: record.id,
        expectedRevision: revision,
        expectedFingerprint: saved.fingerprint,
      });
      const client = await getSourceControlClient();
      const result = await runDesktopLiveJob(
        sourceControlContract.checkout.pushBranch,
        client.checkout.pushBranch,
        plan
      );
      if (!result.success)
        throw new Error('message' in result.error ? result.error.message : result.error.type);
      setReceipt({ oid: result.data.oid, destination: saved.destination });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 border-t border-border pt-2" data-testid="coordinator-document-push">
      <p className="text-xs text-foreground-muted">
        {saved
          ? `Document remote: ${saved.remote} · ${saved.destination}`
          : 'Management documents are stored locally.'}
      </p>
      <details>
        <summary className="cursor-pointer text-xs">Configure document remote</summary>
        <div className="mt-2 space-y-2">
          <p className="text-xs text-foreground-muted">
            Choose your personal fork for documents. Saving this selection does not push.
          </p>
          <Select.Root value={value} onValueChange={(value) => setSelection(value ?? 'local')}>
            <Select.Trigger
              disabled={disabled || busy}
              aria-label="Document push remote"
              data-testid="document-push-remote"
            >
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="local">Keep documents local</Select.Item>
              {options.data?.targets.map((target) => (
                <Select.Item key={target.remote} value={`remote:${target.remote}`}>
                  {target.remote} · {target.destination}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          {options.error && (
            <p role="alert" className="text-xs">
              {String(options.error)}
            </p>
          )}
          {options.data?.unavailable.map((target) => (
            <p key={target.remote} className="text-xs">
              {target.remote}: {target.message}
            </p>
          ))}
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || busy || !changed || (value !== 'local' && !selected)}
            onClick={() => void configure()}
          >
            Save document remote
          </Button>
        </div>
      </details>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || busy || !saved}
          onClick={() => void push()}
        >
          Push committed documents
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || busy}
          onClick={() => void Promise.all([options.refetch(), refresh()])}
        >
          Refresh document Git state
        </Button>
      </div>
      {receipt && (
        <p role="status" data-testid="coordinator-document-pushed" className="text-xs">
          Pushed {receipt.oid} to {receipt.destination}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-foreground-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
