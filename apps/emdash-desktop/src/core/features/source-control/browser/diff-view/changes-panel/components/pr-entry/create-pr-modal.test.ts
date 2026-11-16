import { localBranchRefSchema } from '@emdash/core/runtimes/git/api';
import { JSDOM } from 'jsdom';
import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TaskPullRequestInput,
  TaskPullRequestRecord,
} from '@core/features/source-control/api/task-pull-requests';
import { CreatePrModal } from './create-pr-modal';

const mocks = vi.hoisted(() => ({
  provider: 'github',
  enabled: true,
  accountAvailable: true,
  published: true,
  resolveAccount: vi.fn(),
  save: vi.fn(async () => ({ success: true })),
  prepare: vi.fn<(input: TaskPullRequestInput) => Promise<TaskPullRequestRecord>>(),
  run: vi.fn<() => Promise<TaskPullRequestRecord>>(),
  list: vi.fn<() => Promise<TaskPullRequestRecord[]>>(),
  complete: vi.fn(),
}));

vi.mock('@core/features/integrations/api/browser/use-project-account', () => ({
  useProjectAccount: (...args: unknown[]) => {
    mocks.resolveAccount(...args);
    return {
      value: mocks.accountAvailable ? { accountId: 'current' } : null,
      provenance: { kind: 'inferred' },
    };
  },
}));
vi.mock('@core/features/integrations/api/browser/use-provider-accounts', () => ({
  useAccounts: () => ({ data: mocks.accountAvailable ? [{ accountId: 'current' }] : [] }),
}));
vi.mock('@core/features/integrations/contributions/browser/integrations-provider', () => ({
  useIntegrationsContext: () => ({
    integrationById: { github: { name: 'GitHub' }, gitlab: { name: 'GitLab' } },
  }),
}));
vi.mock('@core/features/integrations/contributions/browser/integration-icon', () => ({
  IntegrationIcon: () => null,
}));
vi.mock('@core/features/integrations/contributions/browser/provider-identity-strip', () => ({
  ProviderIdentityStrip: ({
    providerName,
    onSelect,
  }: {
    providerName: string;
    onSelect: (account: { accountId: string }) => void;
  }) =>
    React.createElement(
      'button',
      { onClick: () => onSelect({ accountId: 'selected' }) },
      `Choose ${providerName} account`
    ),
}));
vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectSettingsStore: () => ({ save: mocks.save }),
}));
vi.mock('@core/features/source-control/api/browser/stores/source-control-selectors', () => ({
  getGitRepositoryStore: () => {
    const remote = { name: 'origin', url: `https://${mocks.provider}.com/acme/app` };
    const branch = { type: 'remote', remote, branch: 'main' };
    return {
      providerRepository: {
        provider: mocks.provider,
        capabilities: { pullRequests: mocks.enabled },
      },
      defaultBranchRef: branch,
      branchRefs: [branch],
      remotes: [remote],
      baseRemote: remote,
      pushRemote: remote,
      effectiveGitSettings: { baseRemote: { value: 'origin', provenance: { kind: 'inferred' } } },
    };
  },
}));
vi.mock('@core/features/workspaces/api/browser/stores/workspace-registry', () => ({
  workspaceRegistry: {
    get: () => ({ get: () => ({ isPublished: mocks.published, aheadCount: 0 }) }),
  },
}));
vi.mock('@core/manifests/browser/modal-api', () => ({
  useModalController: () => ({ complete: mocks.complete }),
  useOpenModal: () => vi.fn(),
}));
vi.mock('@core/primitives/modals/react', () => ({ defineModal: () => (value: unknown) => value }));
vi.mock('@core/features/source-control/api/browser/client', () => ({
  getSourceControlClient: async () => ({
    taskPullRequests: { prepare: mocks.prepare, run: mocks.run, list: mocks.list },
  }),
}));
vi.mock('@core/features/source-control/contributions/browser/project-branch-selector', () => ({
  ProjectBranchSelector: () => null,
}));
vi.mock('@core/features/source-control/contributions/browser/branch-display', () => ({
  BranchDisplay: () => null,
}));
vi.mock('@core/features/source-control/contributions/browser/remote-selector', () => ({
  RemoteSelector: () => null,
}));
vi.mock('@core/features/projects/contributions/browser/settings-provenance', () => ({
  BrokenSettingNotice: () => null,
}));
vi.mock('@core/primitives/keybindings/browser/confirm-button', () => ({
  ConfirmButton: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick: () => void;
    disabled: boolean;
  }) => React.createElement('button', { onClick, disabled }, children),
}));
vi.mock('@emdash/ui/react/primitives', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const container = ({ children }: { children: ReactNode }) =>
    React.createElement('div', null, children);
  return {
    ...actual,
    Dialog: { Header: container, Body: container, Footer: container, Title: container },
  };
});

describe('CreatePrModal provider routing', () => {
  let saved: TaskPullRequestRecord | undefined;
  let dom: JSDOM;
  let root: Root;
  let container: HTMLElement;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.provider = 'github';
    mocks.enabled = true;
    mocks.accountAvailable = true;
    mocks.published = true;
    mocks.save.mockResolvedValue({ success: true });
    saved = undefined;
    mocks.prepare.mockImplementation(async (input) => {
      saved = {
        version: '2',
        fingerprint: 'fingerprint',
        requestId: input.requestId,
        phase: 'prepared',
        plan: {
          taskId: input.taskId,
          projectId: 'project',
          workspaceId: 'workspace',
          sourceRef: localBranchRefSchema.parse('refs/heads/feature'),
          oid: 'a'.repeat(40),
          pushTarget: {
            remote: 'origin',
            destination: `https://${mocks.provider}.com/acme/app`,
            fingerprint: 'b'.repeat(64),
          },
          repositoryUrl: input.repositoryUrl ?? '',
          headRepositoryUrl: `https://${mocks.provider}.com/acme/app`,
          base: input.base ?? '',
          title: input.title,
          draft: input.draft,
          push: input.push,
        },
      };
      return saved;
    });
    mocks.run.mockImplementation(async () => {
      if (!saved) throw new Error('No prepared request');
      saved = {
        ...saved,
        phase: 'complete',
        result: { url: `${saved.plan.repositoryUrl}/pull/7`, number: 7 },
      };
      return saved;
    });
    mocks.list.mockImplementation(async () => (saved ? [saved] : []));
    dom = new JSDOM('<div id="root"></div>');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    container = dom.window.document.getElementById('root')!;
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    dom.window.close();
  });
  async function render(provider: string) {
    mocks.provider = provider;
    await act(async () =>
      root.render(
        React.createElement(CreatePrModal, {
          projectId: 'project',
          taskId: 'task',
          workspaceId: 'workspace',
          repositoryUrl: `https://${provider}.com/acme/app`,
          branchName: 'feature',
          draft: false,
        })
      )
    );
  }
  function button(text: string) {
    const result = [...container.querySelectorAll('button')].find(
      (element) => element.textContent === text
    );
    if (!result) throw new Error(`Button not found: ${text}`);
    return result;
  }
  it.each([
    ['github', 'GitHub', 'PR', 'Pull Request'],
    ['gitlab', 'GitLab', 'MR', 'Merge Request'],
  ])(
    'routes %s creation and account persistence through the selected provider',
    async (provider, name, short, title) => {
      await render(provider);
      expect(container.textContent).toContain(`Create ${title}`);
      expect(container.querySelector('input')?.placeholder).toBe(`${short} title`);
      expect(mocks.resolveAccount).toHaveBeenCalledWith('project', provider, {
        repository: { kind: 'url', url: `https://${provider}.com/acme/app` },
      });
      await act(async () => button(`Choose ${name} account`).click());
      expect(mocks.save).toHaveBeenCalledWith({
        integrationAccounts: {
          stored: {
            [provider]: { kind: 'account', accountId: 'selected' },
          },
        },
      });
      await act(async () => button(`Create ${short}`).click());
      expect(mocks.prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryUrl: `https://${provider}.com/acme/app`,
          sourceBranch: 'feature',
          push: false,
          workspaceId: 'workspace',
          base: 'main',
          draft: false,
        }),
        { timeoutMs: 0 }
      );
      expect(mocks.complete).toHaveBeenCalled();
    }
  );
  it('blocks GitLab creation when the repository capability is disabled', async () => {
    mocks.enabled = false;
    await render('gitlab');
    expect(button('Create MR').disabled).toBe(true);
    await act(async () => button('Create MR').click());
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('reuses the same saved request after an unchanged retry', async () => {
    mocks.run.mockRejectedValueOnce(new Error('Platform disconnected'));
    await render('github');
    await act(async () => button('Create PR').click());
    expect(container.textContent).toContain('Platform disconnected');
    expect(container.textContent).toContain('Existing remote commit; no push');
    await act(async () => button('Create PR').click());
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    expect(mocks.prepare.mock.calls[0]?.[0].requestId).toBe(
      mocks.prepare.mock.calls[1]?.[0].requestId
    );
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
  it('sends push-and-create through the same durable preparation and execution', async () => {
    mocks.published = false;
    await render('github');
    await act(async () => button('Push & Create PR').click());
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task',
        push: true,
        pushRemote: 'origin',
        sourceBranch: 'feature',
        workspaceId: 'workspace',
      }),
      { timeoutMs: 0 }
    );
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
  it('shows matching PR candidates and keeps the creation dialog open on ambiguity', async () => {
    mocks.run.mockImplementationOnce(async () => {
      if (!saved) throw new Error('No prepared request');
      saved = {
        ...saved,
        phase: 'creating',
        failure: {
          type: 'pull_request_match_ambiguous',
          message: 'Choose an existing pull request.',
          candidates: [
            { number: 7, url: 'https://github.com/acme/app/pull/7' },
            { number: 8, url: 'https://github.com/acme/app/pull/8' },
          ],
        },
      };
      throw new Error('Choose an existing pull request.');
    });
    await render('github');
    await act(async () => button('Create PR').click());
    expect(container.textContent).toContain('Choose an existing pull request.');
    expect(button('https://github.com/acme/app/pull/7')).toBeDefined();
    expect(button('https://github.com/acme/app/pull/8')).toBeDefined();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('blocks GitLab creation without an account', async () => {
    mocks.accountAvailable = false;
    await render('gitlab');
    expect(button('Create MR').disabled).toBe(true);
    await act(async () => button('Create MR').click());
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('blocks GitLab creation after the account preference fails to save', async () => {
    mocks.save.mockResolvedValueOnce({ success: false });
    await render('gitlab');
    await act(async () => button('Choose GitLab account').click());
    expect(container.textContent).toContain('before creating the MR');
    expect(button('Create MR').disabled).toBe(true);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
