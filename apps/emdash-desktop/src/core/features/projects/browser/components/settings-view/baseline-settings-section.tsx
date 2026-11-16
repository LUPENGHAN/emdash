import { Button, Field, Input, Textarea } from '@emdash/ui/react/primitives';
import { remote, type RemoteModel } from '@emdash/wire/state';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type { ProjectBaselineSnapshot } from '@core/features/projects/api/baseline-sync';
import { getProjectsWireClient } from '@core/features/projects/api/browser/client';
import { projectsWireContract } from '@core/features/projects/api/wire-contract';
import type { Project } from '@core/primitives/projects/api';
import { useRemoteModelState } from '@core/primitives/wire/browser/use-remote-model-state';

let baselineRemote: Promise<RemoteModel<typeof projectsWireContract.baseline>> | undefined;
function getBaselineRemote() {
  baselineRemote ??= getProjectsWireClient().then((client) =>
    remote(projectsWireContract.baseline, client.baseline, { lingerMs: 15000 })
  );
  return baselineRemote;
}

const labels: Record<ProjectBaselineSnapshot['status'], string> = {
  'not-checked': 'Not checked',
  'needs-check': 'Check required',
  interrupted: 'Check interrupted',
  fetching: 'Checking upstream',
  verifying: 'Running verification',
  ready: 'Ready for delegation',
  offline: 'Using a local baseline while offline',
  blocked: 'Synchronization blocked',
  failed: 'Check failed',
};

type Draft = { revision: number; command: string; timeout: string };
export function BaselineSettingsSection({
  project,
  disabledReason,
}: {
  project: Project;
  disabledReason: string | null;
}) {
  const projectId = project.id;
  const commandId = useId();
  const timeoutId = useId();
  const availability = useQuery({
    queryKey: [
      'baseline-project-path',
      projectId,
      project.type,
      project.path,
      project.type === 'ssh' ? project.connectionId : null,
    ],
    queryFn: async () =>
      (await getProjectsWireClient()).inspectProjectPath(
        project.type === 'ssh'
          ? { type: 'ssh', path: project.path, connectionId: project.connectionId }
          : { type: 'local', path: project.path }
      ),
    enabled: !disabledReason,
  });
  const state = useRemoteModelState(
    projectsWireContract.baseline,
    getBaselineRemote,
    { projectId },
    'current'
  );
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const value = state.value;
  const saved: Draft = {
    revision: value?.revision ?? 0,
    command: value?.config.verification?.command ?? '',
    timeout:
      value?.config.verification?.timeoutMs === undefined
        ? ''
        : String(value.config.verification.timeoutMs / 1000),
  };
  const form = draft ?? saved;
  const last = value?.attempts.at(-1);
  const targetKey = last ? JSON.stringify(last.target) : undefined;
  const verification =
    last?.verification ??
    value?.attempts
      .slice()
      .reverse()
      .find(
        (attempt) =>
          attempt.revision === last?.revision &&
          attempt.observation?.oid === last?.observation?.oid &&
          JSON.stringify(attempt.target) === targetKey &&
          attempt.verification !== undefined
      )?.verification;
  const statusLabel =
    last?.revision === value?.revision && last?.error?.code === 'verification-failed'
      ? 'Verification failed'
      : last?.revision === value?.revision && last?.error?.code === 'verification-unknown'
        ? 'Verification outcome unknown'
        : value
          ? labels[value.status]
          : '';
  const pending = value?.status === 'fetching' || value?.status === 'verifying';
  const update = (patch: Partial<Draft>) => setDraft({ ...form, ...patch });
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      const timeoutMs = form.timeout.trim() ? Number(form.timeout) * 1000 : undefined;
      if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0))
        throw new Error('Enter a positive timeout in seconds, or leave it empty.');
      await (
        await getProjectsWireClient()
      ).configureBaseline({
        projectId,
        expectedRevision: form.revision,
        config: { verification: form.command.trim() ? { command: form.command, timeoutMs } : null },
      });
      await state.refresh();
      setDraft(undefined);
    });
  if (availability.data && !availability.data.error && !availability.data.isGitRepo)
    return (
      <section className="border-t border-border py-6" aria-label="Code baseline">
        <h3 className="text-sm font-medium">Code baseline</h3>
        <p className="text-xs text-foreground-muted">
          Baseline synchronization applies to Git repositories. This directory project has no code
          baseline.
        </p>
      </section>
    );
  const blocked =
    disabledReason ??
    (availability.error || availability.data?.error
      ? 'Cannot inspect the Project repository. Reload its status before checking the baseline.'
      : availability.isPending
        ? 'Checking whether this Project has a Git repository…'
        : null);
  return (
    <section className="space-y-3 border-t border-border py-6" aria-label="Code baseline">
      <div>
        <h3 className="text-sm font-medium">Code baseline</h3>
        <p className="text-xs text-foreground-muted">
          Follow the configured upstream with safe fast-forwards before delegating code tasks. Task
          branches stay on their own commits. The personal fork is not pushed automatically.
        </p>
      </div>
      <Field.Root>
        <Field.Label htmlFor={commandId}>Baseline verification command</Field.Label>
        <Textarea
          id={commandId}
          value={form.command}
          disabled={!value || busy || !!blocked}
          onChange={(event) => update({ command: event.target.value })}
          placeholder="pnpm install --frozen-lockfile && pnpm test"
        />
        <Field.Description>
          Runs in a separate checkout of the selected commit. Include dependency installation when
          needed. Leave empty to check Git synchronization only. Failed verification blocks
          automatic delegation from that commit.
        </Field.Description>
      </Field.Root>
      <Field.Root>
        <Field.Label htmlFor={timeoutId}>Verification timeout (seconds, optional)</Field.Label>
        <Input
          id={timeoutId}
          type="number"
          min="0.001"
          step="any"
          value={form.timeout}
          disabled={!value || busy || !!blocked || !form.command.trim()}
          onChange={(event) => update({ timeout: event.target.value })}
        />
      </Field.Root>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!draft || busy || !!blocked}
          onClick={() => void save()}
        >
          Save baseline settings
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!value || busy || pending || !!draft || !!blocked}
          onClick={() =>
            void run(async () => {
              await (await getProjectsWireClient()).synchronizeBaseline({ projectId });
              await state.refresh();
            })
          }
        >
          {pending ? 'Checking…' : 'Check baseline'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await Promise.all([state.refresh(), availability.refetch()]);
              setDraft(undefined);
            })
          }
        >
          {draft ? 'Discard edits and reload' : 'Reload status'}
        </Button>
      </div>
      {blocked ? <p className="text-xs text-foreground-muted">{blocked}</p> : null}
      {error || state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {error ?? String(state.error)}
        </p>
      ) : null}
      {value ? (
        <div className="space-y-1 text-xs" role="status">
          <p>{statusLabel}</p>
          <p>
            Last upstream contact:{' '}
            {value.lastContactAt === null
              ? 'Never'
              : new Date(value.lastContactAt).toLocaleString()}
          </p>
          {last ? (
            <p className="break-all">
              {last.target.baselineRef} ·{' '}
              {last.target.remote
                ? `${last.target.remote}/${last.target.upstreamRef}`
                : 'Local baseline'}
            </p>
          ) : null}
          {last?.observation ? (
            <p className="break-all">
              {last.observation.beforeOid ?? 'Unknown'} → {last.observation.oid ?? 'Unknown'}
            </p>
          ) : null}
          {value.resolutionError?.revision === value.revision ? (
            <p>{value.resolutionError.message}</p>
          ) : null}
          {last?.error ? <p>{last.error.message}</p> : null}
          {verification?.message ? <p>{verification.message}</p> : null}
          {verification?.workspacePath ? (
            <p className="break-all">Verification checkout: {verification.workspacePath}</p>
          ) : null}
          {verification?.output ? (
            <pre className="max-h-64 overflow-auto rounded border border-border p-2 whitespace-pre-wrap">
              {verification.output}
            </pre>
          ) : null}
        </div>
      ) : state.isLoading ? (
        <p className="text-xs">Loading baseline status…</p>
      ) : null}
    </section>
  );
}
