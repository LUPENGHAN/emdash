import '@emdash/ui/style.css';
import '@renderer/index.css';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { GatewayModel } from '@core/features/model-gateway/api/model-catalog';
import type { ModelSourceValue } from '@core/features/model-providers/api';
import { ModelSourceSelect } from '@core/features/model-providers/contributions/browser/model-source-select';
import { ThemeProvider } from '@core/primitives/theme/browser/theme-provider';

const mocks = vi.hoisted(() => ({
  changed: vi.fn(),
  defaults: {} as ModelSourceValue,
  providers: [
    { id: 'physical-provider', name: 'Private provider', baseUrl: 'http://internal', models: [] },
  ],
  models: [] as GatewayModel[],
}));
vi.mock('@core/features/settings/api/browser/use-app-settings-key', () => ({
  useAppSettingsKey: (key: string) => ({
    value:
      key === 'gatewayModels'
        ? { version: 1, models: mocks.models }
        : { providers: mocks.providers },
  }),
}));
vi.mock('@core/features/agents/api/browser/client', () => ({
  hostRefFromConnectionId: () => ({ kind: 'local' }),
}));
vi.mock('@core/features/agents/api/browser/use-agent-settings', () => ({
  useAgentSettings: () => ({ value: mocks.defaults }),
}));
let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  await page.viewport(820, 650);
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.changed.mockClear();
  mocks.defaults = {};
  mocks.models = [
    {
      id: 'one',
      alias: 'deepseek-fast',
      name: 'DeepSeek Flash',
      providerId: 'physical-provider',
      enabled: true,
      revision: 1,
      protocolModels: { anthropic: { upstreamModel: 'physical' } },
      protocolPolicy: { mode: 'auto' },
    },
    {
      id: 'two',
      alias: 'responses-only',
      name: 'Responses model',
      providerId: 'physical-provider',
      enabled: true,
      revision: 1,
      protocolModels: { 'openai-responses': { upstreamModel: 'physical' } },
      protocolPolicy: { mode: 'auto' },
    },
  ];
  host = document.createElement('div');
  host.style.width = '540px';
  host.style.padding = '24px';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
function Form({ remote = false, initial = {} }: { remote?: boolean; initial?: ModelSourceValue }) {
  const [value, setValue] = useState(initial);
  return (
    <ThemeProvider theme="emlight" onThemeChange={() => {}}>
      <ModelSourceSelect
        agentId="claude"
        remote={remote}
        value={value}
        onChange={(next) => {
          mocks.changed(next);
          setValue(next);
        }}
      />
    </ThemeProvider>
  );
}
it('offers a gateway and a public model without asking for the physical provider', async () => {
  await act(async () => root.render(<Form />));
  await page.getByText('Official login (Claude subscription)', { exact: true }).click();
  await expect
    .element(page.getByRole('option', { name: 'Private provider' }))
    .not.toBeInTheDocument();
  await page.getByRole('option', { name: 'Gateway', exact: true }).click();
  await page.getByText('Select a model', { exact: true }).click();
  await expect
    .element(page.getByRole('option', { name: /Responses model/ }))
    .not.toBeInTheDocument();
  await page.getByRole('option', { name: /DeepSeek Flash/ }).click();
  expect(mocks.changed).toHaveBeenLastCalledWith({
    modelSource: 'gateway:models',
    sourceModel: 'deepseek-fast',
  });
  await page.getByText('Gateway model', { exact: true }).click();
  await page.screenshot({ element: host, path: '/tmp/emdash-model-first-picker.png' });
  await page.getByRole('button', { name: 'Restore agent default' }).click();
  expect(mocks.changed).toHaveBeenLastCalledWith({});
});
it('shows an inherited gateway model and preserves a missing saved selection', async () => {
  mocks.defaults = { modelSource: 'gateway:models', sourceModel: 'deepseek-fast' };
  await act(async () => root.render(<Form />));
  await expect
    .element(page.getByText('DeepSeek Flash · deepseek-fast', { exact: true }))
    .toBeVisible();
  expect(mocks.changed).not.toHaveBeenCalled();
  await act(async () =>
    root.render(
      <Form initial={{ modelSource: 'gateway:models', sourceModel: 'removed' }} key="saved" />
    )
  );
  await expect.element(page.getByText('removed (unavailable)', { exact: true })).toBeVisible();
  expect(mocks.changed).not.toHaveBeenCalled();
});
it('disables the local gateway on remote hosts', async () => {
  await act(async () => root.render(<Form remote />));
  await page.getByText('Official login (Claude subscription)', { exact: true }).click();
  await expect
    .element(page.getByRole('option', { name: 'Gateway (local agents only)' }))
    .toHaveAttribute('aria-disabled', 'true');
});
