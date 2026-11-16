import '@emdash/ui/style.css';
import '@renderer/index.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { GatewayModel } from '@core/features/model-gateway/api/model-catalog';
import { GatewayModelsPanel } from '@core/features/model-gateway/contributions/browser/models-panel';
import { ThemeProvider } from '@core/primitives/theme/browser/theme-provider';

const mocks = vi.hoisted(() => ({
  models: [] as GatewayModel[],
  preview: vi.fn(),
  save: vi.fn(),
  testRoute: vi.fn(),
}));
vi.mock('@core/features/settings/api/browser/use-app-settings-key', () => ({
  useAppSettingsKey: (key: string) => ({
    value:
      key === 'gatewayModels'
        ? { version: 1, models: mocks.models }
        : {
            providers: [
              {
                id: 'p',
                name: 'Internal API',
                baseUrl: 'http://internal',
                models: [],
                endpoints: { anthropic: '', 'openai-chat': '' },
              },
            ],
          },
    isLoading: false,
  }),
}));
vi.mock('@core/features/model-gateway/api/browser/client', () => ({
  getModelGatewayClient: async () => ({
    migrationPreview: mocks.preview,
    saveModels: mocks.save,
    testModel: mocks.testRoute,
  }),
}));
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  await page.viewport(1080, 1000);
  mocks.models = [];
  mocks.testRoute.mockReset();
  mocks.testRoute.mockResolvedValue({ ok: true, status: 200 });
  mocks.save.mockReset();
  mocks.preview.mockReset();
  mocks.preview.mockResolvedValue([
    {
      id: 'preview',
      alias: 'fast',
      name: 'Fast model',
      enabled: true,
      revision: 1,
      providerId: 'p',
      protocolModels: {
        anthropic: { upstreamModel: 'physical' },
        'openai-chat': { upstreamModel: 'physical' },
      },
      protocolPolicy: { mode: 'auto' },
    },
  ]);
  mocks.save.mockImplementation(async ({ models }: { models: GatewayModel[] }) => {
    mocks.models = models;
  });
  host = document.createElement('div');
  host.style.width = '900px';
  host.style.padding = '24px';
  document.body.appendChild(host);
  root = createRoot(host);
  client = new QueryClient();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ThemeProvider theme="emlight" onThemeChange={() => {}}>
          <GatewayModelsPanel />
        </ThemeProvider>
      </QueryClientProvider>
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
});
it('previews and edits protocol mappings before explicitly publishing the catalog', async () => {
  await act(async () => {
    await page.getByRole('button', { name: 'Preview models from providers' }).click();
  });
  await act(async () => {
    await page.getByText('Fast model · fast', { exact: true }).click();
  });
  expect(mocks.save).not.toHaveBeenCalled();
  await act(async () => {
    await page.getByLabelText('Display name', { exact: true }).fill('Coding model');
  });
  await act(async () => {
    await page.getByRole('checkbox', { name: 'OpenAI Chat Completions', exact: true }).click();
  });
  await act(async () => {
    await page.getByRole('button', { name: 'Publish reviewed models' }).click();
  });
  expect(mocks.save).toHaveBeenCalledWith({
    models: [
      expect.objectContaining({
        alias: 'fast',
        name: 'Coding model',
        protocolModels: { anthropic: { upstreamModel: 'physical' } },
        protocolPolicy: { mode: 'auto' },
      }),
    ],
  });
  await act(async () => {
    await page.getByText('Coding model · fast', { exact: true }).click();
  });
  await expect.element(page.getByLabelText('Model alias', { exact: true })).toBeDisabled();
  await act(async () => {
    await page.getByRole('button', { name: 'Test Claude route' }).click();
  });
  expect(mocks.testRoute).toHaveBeenCalledWith({ alias: 'fast', agent: 'claude' });
  await expect
    .element(page.getByRole('status'))
    .toHaveTextContent('Received a valid protocol response.');
  await page.screenshot({ element: host, path: '/tmp/emdash-gateway-model-settings.png' });
});
it('keeps drafts and shows the error when publishing fails', async () => {
  await act(async () => {
    await page.getByRole('button', { name: 'Preview models from providers' }).click();
  });
  mocks.save.mockRejectedValueOnce(new Error('Secure model settings are unavailable'));
  await act(async () => {
    await page.getByRole('button', { name: 'Publish reviewed models' }).click();
  });
  await expect
    .element(page.getByRole('alert'))
    .toHaveTextContent('Secure model settings are unavailable');
  await expect.element(page.getByRole('button', { name: 'Discard changes' })).toBeEnabled();
});
