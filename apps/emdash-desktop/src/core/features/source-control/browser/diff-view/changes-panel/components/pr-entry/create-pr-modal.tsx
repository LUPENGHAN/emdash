import { parseRepositoryRef } from '@emdash/core/primitives/repository/api';
import type { GitBranchRef } from '@emdash/core/runtimes/git/api';
import {
  Alert,
  Button,
  Combobox,
  Dialog,
  Field,
  Input,
  Separator,
  SplitButton,
  Textarea,
} from '@emdash/ui/react/primitives';
import { ChevronDown, GitBranch, GitPullRequest } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useMemo, useRef, useState } from 'react';
import { useProjectAccount } from '@core/features/integrations/api/browser/use-project-account';
import { useAccounts } from '@core/features/integrations/api/browser/use-provider-accounts';
import { identityStripView } from '@core/features/integrations/api/identity-strip-state';
import { IntegrationIcon } from '@core/features/integrations/contributions/browser/integration-icon';
import { useIntegrationsContext } from '@core/features/integrations/contributions/browser/integrations-provider';
import { ProviderIdentityStrip } from '@core/features/integrations/contributions/browser/provider-identity-strip';
import { getProjectSettingsStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { BrokenSettingNotice } from '@core/features/projects/contributions/browser/settings-provenance';
import { getSourceControlClient } from '@core/features/source-control/api/browser/client';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import type { TaskPullRequestRecord } from '@core/features/source-control/api/task-pull-requests';
import { BranchDisplay } from '@core/features/source-control/contributions/browser/branch-display';
import { ProjectBranchSelector } from '@core/features/source-control/contributions/browser/project-branch-selector';
import { RemoteSelector } from '@core/features/source-control/contributions/browser/remote-selector';
import { gitCheckoutStoreToken } from '@core/features/source-control/contributions/browser/workspace-store-tokens';
import { workspaceRegistry } from '@core/features/workspaces/api/browser/stores/workspace-registry';
import { useModalController, useOpenModal } from '@core/manifests/browser/modal-api';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';
import type { ProviderAccountSummary } from '@core/primitives/provider-accounts/api';
import { isManagementBranch } from '@core/primitives/workspaces/api/management-branch';
import { resolveInitialBaseBranch } from './base-branch';
import { getTargetRemotes, resolveCreatePrTargetRemote } from './target-remote';

export type CreatePrModalArgs = {
  projectId: string;
  taskId: string;
  repositoryUrl: string;
  branchName: string;
  draft: boolean;
  workspaceId: string;
};

export const CreatePrModal = observer(function CreatePrModal({
  projectId,
  taskId,
  repositoryUrl,
  branchName,
  draft,
  workspaceId,
}: CreatePrModalArgs) {
  const { complete } = useModalController('createPrModal');
  const managementBranch = isManagementBranch(branchName);
  const openIntegrationSetup = useOpenModal('integrationSetupModal');
  const [title, setTitle] = useState(branchName);
  const [description, setDescription] = useState('');
  const [selectedBaseOverride, setSelectedBaseOverride] = useState<GitBranchRef | undefined>();
  const [selectedTargetRemoteName, setSelectedTargetRemoteName] = useState<string | undefined>();
  const [isCreating, setIsCreating] = useState(false);
  const [createActionId, setCreateActionId] = useState('push-and-create');
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<{ url: string; number: number }[]>([]);
  const [prepared, setPrepared] = useState<TaskPullRequestRecord>();
  const request = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  const [accountOverride, setAccountOverride] = useState<ProviderAccountSummary | null>(null);
  const [accountSaveState, setAccountSaveState] = useState<'idle' | 'saving' | 'failed'>('idle');
  const accountSaveInFlight = useRef(false);
  const repo = getGitRepositoryStore(projectId);
  const provider = repo?.providerRepository?.provider ?? 'github';
  const { integrationById } = useIntegrationsContext();
  const providerName =
    integrationById[provider]?.name ?? (provider === 'gitlab' ? 'GitLab' : 'GitHub');
  const short = provider === 'gitlab' ? 'MR' : 'PR';
  const noun = provider === 'gitlab' ? 'merge request' : 'pull request';
  const checkout = workspaceRegistry.get(workspaceId)?.get(gitCheckoutStoreToken);
  // Creation requires a resolved account and a persisted account selection.
  const resolvedAccount = useProjectAccount(projectId, provider, {
    repository: { kind: 'url', url: repositoryUrl },
  });
  const { data: accounts } = useAccounts(provider);
  const identityBlocked =
    !repo?.providerRepository?.capabilities.pullRequests ||
    accountSaveState !== 'idle' ||
    !resolvedAccount ||
    !accounts ||
    identityStripView(providerName, resolvedAccount, accountOverride, accounts).kind !== 'account';
  // The worker resolves credentials from the saved project account.
  const handleSelectAccount = async (account: ProviderAccountSummary) => {
    if (accountSaveInFlight.current || isCreating) return;
    accountSaveInFlight.current = true;
    setAccountSaveState('saving');
    setAccountOverride(account);
    setError(null);
    try {
      const settings = getProjectSettingsStore(projectId);
      if (!settings) throw new Error('Project settings are unavailable.');
      const result = await settings.save({
        integrationAccounts: {
          stored: { [provider]: { kind: 'account', accountId: account.accountId } },
        },
      });
      if (!result.success) throw new Error('Could not save the selected account.');
      setAccountSaveState('idle');
    } catch {
      setAccountSaveState('failed');
      setError(
        `Could not save the selected account. Select it again to retry before creating the ${short}.`
      );
    } finally {
      accountSaveInFlight.current = false;
    }
  };
  const defaultBranch = repo?.defaultBranchRef;
  const needsPush = !checkout?.isPublished || checkout.aheadCount > 0;
  const baseRemoteResolution = repo?.effectiveGitSettings.baseRemote ?? null;
  const projectRemoteName = repo?.baseRemote?.name ?? null;
  const fallbackRepository = useMemo(() => parseRepositoryRef(repositoryUrl), [repositoryUrl]);
  const targetRemotes = useMemo(
    () =>
      fallbackRepository
        ? getTargetRemotes(repo?.remotes ?? [], { host: fallbackRepository.host })
        : [],
    [fallbackRepository, repo?.remotes]
  );
  const targetRemote = resolveCreatePrTargetRemote({
    options: targetRemotes,
    projectRemoteName,
    selectedRemoteName: selectedTargetRemoteName,
    fallbackRepositoryUrl: repositoryUrl,
  });
  const targetRepositoryUrl =
    targetRemote?.repository.repositoryUrl ?? fallbackRepository?.repositoryUrl ?? null;

  const hasProviderRemote = Boolean(targetRepositoryUrl);
  const selectedBase =
    selectedBaseOverride ??
    resolveInitialBaseBranch(
      repo?.branchRefs.filter((branch) => branch.type === 'remote') ?? [],
      undefined,
      defaultBranch,
      targetRemote?.remote.name ?? projectRemoteName
    );

  const handleTargetRemoteChange = (remoteName: string) => {
    setSelectedTargetRemoteName(remoteName);
    setSelectedBaseOverride(undefined);
  };

  const doCreate = async (push: boolean) => {
    if (managementBranch) {
      setError('Management documents cannot be used as a code pull request source.');
      return;
    }
    if (identityBlocked || accountSaveInFlight.current || isCreating) return;
    if (!selectedBase?.branch) {
      setError(`Select a base branch before creating the ${noun}.`);
      return;
    }
    if (!title.trim() || !targetRepositoryUrl) return;
    if (!repo?.pushRemote?.name) {
      setError(`Select a valid push remote before creating the ${noun}.`);
      return;
    }
    setError(null);
    setCandidates([]);
    setPrepared(undefined);
    setIsCreating(true);
    const selection = {
      taskId,
      workspaceId,
      sourceBranch: branchName,
      pushRemote: repo.pushRemote.name,
      repositoryUrl: targetRepositoryUrl,
      base: selectedBase.branch,
      title: title.trim(),
      body: description.trim() || undefined,
      draft,
      push,
    };
    const fingerprint = JSON.stringify(selection);
    if (request.current?.fingerprint !== fingerprint)
      request.current = { fingerprint, id: crypto.randomUUID() };
    const requestId = request.current.id;
    try {
      const client = (await getSourceControlClient()).taskPullRequests;
      setPrepared(await client.prepare({ ...selection, requestId }, { timeoutMs: 0 }));
      const result = await client.run({ taskId, requestId }, { timeoutMs: 0 });
      if (result.phase !== 'complete' || !result.result)
        throw new Error('The PR request has no completed receipt.');
      complete();
    } catch (cause) {
      setError(String(cause));
      try {
        const saved = (
          await (await getSourceControlClient()).taskPullRequests.list({ taskId })
        ).find((entry) => entry.requestId === requestId);
        if (saved) setPrepared(saved);
        if (saved?.failure?.type === 'pull_request_match_ambiguous')
          setCandidates(saved.failure.candidates);
      } catch {
        /* Keep the original operation error when the host cannot refresh the request. */
      }
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="flex max-h-[70vh] flex-col overflow-hidden">
      <Dialog.Header>
        <Dialog.Title>
          {draft
            ? `Create Draft ${short}`
            : provider === 'gitlab'
              ? 'Create Merge Request'
              : 'Create Pull Request'}
        </Dialog.Title>
      </Dialog.Header>
      <Dialog.Body className="space-y-4">
        {managementBranch && (
          <p role="alert">Management documents cannot be used as a code pull request source.</p>
        )}
        {!hasProviderRemote && (
          <p className="text-muted-foreground text-sm">
            No {providerName} remote detected. Configure a {providerName} remote to create {noun}s.
          </p>
        )}
        {baseRemoteResolution?.provenance.kind === 'broken-setting' ? (
          <BrokenSettingNotice
            staleValue={baseRemoteResolution.provenance.staleValue}
            effectiveValue={baseRemoteResolution.value}
          />
        ) : null}
        <div className="flex flex-col items-center gap-2">
          <BranchDisplay
            label="Head Branch"
            branchName={branchName}
            className="rounded-md border border-border"
          />
          {targetRemotes.length > 1 && targetRemote ? (
            <RemoteSelector
              remotes={targetRemotes.map(({ remote }) => remote)}
              value={targetRemote.remote.name}
              onValueChange={handleTargetRemoteChange}
              className="min-h-[58px] w-full"
              renderTrigger={(selected) => (
                <div className="flex flex-col gap-0.5 text-left text-sm">
                  <span className="text-xs text-foreground-passive">Target</span>
                  <span className="flex items-center gap-1">
                    <GitPullRequest
                      absoluteStrokeWidth
                      strokeWidth={2}
                      className="size-3.5 shrink-0 text-foreground-muted"
                    />
                    <span className="min-w-0 truncate">
                      {selected?.label ?? targetRemote.remote.name}
                    </span>
                  </span>
                </div>
              )}
            />
          ) : null}
          <ProjectBranchSelector
            projectId={projectId}
            value={selectedBase}
            onValueChange={setSelectedBaseOverride}
            remoteOnly
            remoteName={targetRemote?.remote.name}
            branchLabelRemote="short"
            trigger={
              <Combobox.Trigger className="flex w-full items-center justify-between gap-2 rounded-md border border-border p-2 text-left outline-none">
                <div className="flex flex-col gap-0.5 text-left text-sm">
                  <span className="text-xs text-foreground-passive">Base Branch</span>
                  <span className="flex items-center gap-1">
                    <GitBranch
                      absoluteStrokeWidth
                      strokeWidth={2}
                      className="size-3.5 shrink-0 text-foreground-muted"
                    />
                    <Combobox.Value placeholder="Select a base branch" />
                  </span>
                </div>
                <ChevronDown className="size-4 shrink-0 text-foreground-muted" />
              </Combobox.Trigger>
            }
          />
        </div>
        <Separator />
        <Field.Group>
          <Field.Root>
            <Field.Label>Title</Field.Label>
            <Input
              placeholder={`${short} title`}
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={!hasProviderRemote}
            />
          </Field.Root>
          <Field.Root>
            <Field.Label>Description</Field.Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={1}
              disabled={!hasProviderRemote}
            />
          </Field.Root>
        </Field.Group>
        {resolvedAccount && accounts ? (
          <ProviderIdentityStrip
            providerName={providerName}
            providerIcon={
              <IntegrationIcon provider={provider} className="size-4 text-foreground-muted" />
            }
            actionLabel="Creating as"
            emptyState={{
              connect: `Connect a ${providerName} account to continue.`,
              unavailable: `Choose a ${providerName} account to continue.`,
              noMatch: 'No connected account matches this repository.',
            }}
            resolved={resolvedAccount}
            accounts={accounts}
            override={accountOverride}
            persistence="project"
            accountRequired
            disabled={accountSaveState === 'saving' || isCreating}
            onSelect={(account) => void handleSelectAccount(account)}
            onConnect={() => void openIntegrationSetup({ integration: provider })}
          />
        ) : null}
        {error && (
          <Alert.Root status="destructive">
            <Alert.Title>Failed to create {noun}</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
            {candidates.map((candidate) => (
              <Button
                key={candidate.url}
                variant="secondary"
                onClick={() => void openExternal(candidate.url)}
              >
                {candidate.url}
              </Button>
            ))}
          </Alert.Root>
        )}
        {prepared && (
          <p className="text-xs text-foreground-muted" data-testid="prepared-task-pr">
            {prepared.plan.headRepositoryUrl} ·{' '}
            {prepared.plan.sourceRef.slice('refs/heads/'.length)} · {prepared.plan.oid.slice(0, 12)}
            {' → '}
            {prepared.plan.repositoryUrl} · {prepared.plan.base}
            {prepared.plan.push === false
              ? ' · Existing remote commit; no push'
              : ` · Push remote: ${prepared.plan.pushTarget.remote}`}
          </p>
        )}
      </Dialog.Body>
      <Dialog.Footer>
        {needsPush ? (
          <SplitButton
            size="sm"
            loading={isCreating}
            loadingLabel="Creating..."
            disabled={
              managementBranch ||
              !hasProviderRemote ||
              !selectedBase?.branch ||
              !title.trim() ||
              identityBlocked
            }
            options={[
              {
                id: 'push-and-create',
                label: draft ? 'Push & Create Draft' : `Push & Create ${short}`,
              },
              {
                id: 'create-only',
                label: draft ? 'Create Draft' : `Create ${short}`,
                description: `Skip push and open a ${short} from the current remote state`,
              },
            ]}
            selectedId={createActionId}
            onSelectedChange={setCreateActionId}
            commitOnSelect={false}
            onAction={(id) => void doCreate(id === 'push-and-create')}
          />
        ) : (
          <ConfirmButton
            variant="primary"
            size="sm"
            onClick={() => void doCreate(false)}
            disabled={
              managementBranch ||
              !hasProviderRemote ||
              !selectedBase?.branch ||
              !title.trim() ||
              isCreating ||
              identityBlocked
            }
          >
            {isCreating ? 'Creating...' : draft ? 'Create Draft' : `Create ${short}`}
          </ConfirmButton>
        )}
      </Dialog.Footer>
    </div>
  );
});

export const createPrModal = defineModal<void>()({
  id: 'createPrModal',
  component: CreatePrModal,
  size: 'md',
});
