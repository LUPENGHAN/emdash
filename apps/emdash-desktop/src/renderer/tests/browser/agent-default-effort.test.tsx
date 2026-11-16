import '@emdash/ui/style.css';
import '@renderer/index.css';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { AgentDefaultRow } from '@core/features/model-providers/browser/providers-settings-page';
import { ThemeProvider } from '@core/primitives/theme/browser/theme-provider';

const mocks = vi.hoisted(() => ({
  config: { effort: 'low', modelSource: 'internal', sourceModel: 'code' } as {
    effort?: string;
    modelSource?: string;
    sourceModel?: string;
  },
  update: vi.fn(),
}));
vi.mock('@core/features/agents/api/browser/use-agent-settings', () => ({
  useAgentSettings: () => ({ value: mocks.config, updateAsync: mocks.update, isSaving: false }),
}));
vi.mock('@core/features/agents/api/browser/use-agents', () => ({
  useAgent: () => ({
    data: {
      capabilities: {
        effort: {
          kind: 'selectable',
          effortOptions: {
            low: { label: 'Low', level: 1 },
            high: { label: 'High', level: 3 },
          },
        },
      },
    },
  }),
}));
vi.mock('@core/features/settings/api/browser/use-app-settings-key', () => ({
  useAppSettingsKey: (key: string) => ({
    value:
      key === 'gatewayModels'
        ? { models: [] }
        : {
            providers: [
              {
                id: 'internal',
                name: 'Internal',
                baseUrl: 'http://internal',
                models: ['code', 'plain'],
                nonReasoningModels: ['plain'],
                codexReasoning: { levels: ['low'], default: 'low' },
              },
            ],
          },
  }),
}));
vi.mock('@core/features/model-providers/contributions/browser/model-source-select', () => ({
  ModelSourceSelect: ({
    onChange,
  }: {
    onChange: (value: { modelSource: string; sourceModel: string }) => void;
  }) => (
    <button onClick={() => onChange({ modelSource: 'internal', sourceModel: 'plain' })}>
      Choose plain model
    </button>
  ),
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.config = { effort: 'low', modelSource: 'internal', sourceModel: 'code' };
  mocks.update.mockReset();
  mocks.update.mockResolvedValue(undefined);
  host = document.createElement('div');
  host.style.width = '600px';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ThemeProvider theme="emlight" onThemeChange={() => {}}>
        <AgentDefaultRow agentId="codex" />
      </ThemeProvider>
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it('offers model-supported efforts and persists restoring the model default', async () => {
  await page.getByRole('combobox').click();
  await expect.element(page.getByRole('option', { name: 'Low', exact: true })).toBeVisible();
  await expect
    .element(page.getByRole('option', { name: 'High', exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole('option', { name: 'Follow model / agent default' }).click();
  expect(mocks.update).toHaveBeenCalledWith({ ...mocks.config, effort: undefined });
});

it('requires clearing an incompatible effort before changing the model', async () => {
  await page.getByRole('button', { name: 'Choose plain model' }).click();
  expect(mocks.update).not.toHaveBeenCalled();
});
