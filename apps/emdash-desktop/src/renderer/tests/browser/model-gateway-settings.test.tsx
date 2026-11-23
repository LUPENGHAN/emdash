import '@emdash/ui/style.css';
import '@renderer/index.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { PublishedGatewayModel } from '@core/features/model-gateway/api/model-catalog';
import { GatewayModelsPanel } from '@core/features/model-gateway/contributions/browser/models-panel';
import { GatewayProvidersPanel } from '@core/features/model-gateway/contributions/browser/providers-panel';
import { ThemeProvider } from '@core/primitives/theme/browser/theme-provider';

const mocks = vi.hoisted(() => ({
  models: [] as PublishedGatewayModel[],
  preview: vi.fn(),
  save: vi.fn(),
  testRoute: vi.fn(),
  usage: vi.fn(),
}));
vi.mock('@core/features/settings/api/browser/use-app-settings-key', () => ({
  useAppSettingsKey: (key: string) => ({
    value:
      key === 'gatewayModels'
        ? { version: 2, models: mocks.models, ignoredSourceIds: [] }
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
    status: async () => ({ state: 'ready', providers: [] }),
    routes: async () => [],
    usage: mocks.usage,
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
      primaryAlias: 'fast',
      legacyAliases: [],
      displayName: 'Fast model',
      state: 'active',
      revision: 1,
      sources: [
        {
          id: 'source:preview',
          providerId: 'p',
          enabled: true,
          protocolModels: {
            anthropic: { upstreamModel: 'physical' },
            'openai-chat': { upstreamModel: 'physical' },
          },
          protocolPolicy: { mode: 'auto' },
        },
      ],
      activeSourceByProtocol: {
        anthropic: 'source:preview',
        'openai-chat': 'source:preview',
        'openai-responses': 'source:preview',
      },
    },
  ]);
  mocks.save.mockImplementation(async ({ models }: { models: PublishedGatewayModel[] }) => {
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
    await page.getByRole('button', { name: '发现来源' }).click();
  });
  await act(async () => {
    await page.getByRole('button', { name: '作为新模型导入' }).click();
  });
  await act(async () => {
    await page.getByRole('button', { name: /Fast model/ }).click();
  });
  expect(mocks.save).not.toHaveBeenCalled();
  await act(async () => {
    await page.getByLabelText('显示名称', { exact: true }).fill('Coding model');
  });
  await act(async () => {
    await page.getByRole('checkbox', { name: 'OpenAI Chat Completions', exact: true }).click();
  });
  await act(async () => {
    await page.getByRole('button', { name: '保存模型目录' }).click();
  });
  expect(mocks.save).toHaveBeenCalledWith({
    models: [
      expect.objectContaining({
        primaryAlias: 'fast',
        displayName: 'Coding model',
        sources: [
          expect.objectContaining({
            protocolModels: { anthropic: { upstreamModel: 'physical' } },
          }),
        ],
      }),
    ],
    ignoredSourceIds: [],
  });
  await act(async () => {
    await page.getByRole('button', { name: /Coding model/ }).click();
  });
  await expect.element(page.getByLabelText('公开别名', { exact: true })).toBeEnabled();
  await expect.element(page.getByRole('button', { name: '测试 Codex 路由' })).toBeDisabled();
  await act(async () => {
    await page.getByRole('button', { name: '测试 Claude 路由' }).click();
  });
  expect(mocks.testRoute).toHaveBeenCalledWith({ alias: 'fast', agent: 'claude' });
  await expect.element(page.getByRole('status')).toHaveTextContent('协议响应有效');
  await page.screenshot({ element: host, path: '/tmp/emdash-gateway-model-settings.png' });
});
it('keeps drafts and shows the error when publishing fails', async () => {
  await act(async () => {
    await page.getByRole('button', { name: '发现来源' }).click();
  });
  await act(async () => {
    await page.getByRole('button', { name: '作为新模型导入' }).click();
  });
  mocks.save.mockRejectedValueOnce(new Error('Secure model settings are unavailable'));
  await act(async () => {
    await page.getByRole('button', { name: '保存模型目录' }).click();
  });
  await expect
    .element(page.getByRole('alert'))
    .toHaveTextContent('Secure model settings are unavailable');
  await expect.element(page.getByRole('button', { name: '放弃更改' })).toBeEnabled();
});

it('displays reported cache reads and writes and labels legacy usage', async () => {
  const common = {
    accountId: 'p',
    sessionId: 'test',
    at: 0,
    inputTokens: 5,
    outputTokens: 2,
    status: 'complete',
    failed: false,
  };
  mocks.usage.mockResolvedValueOnce([
    {
      ...common,
      id: 'current',
      model: 'current',
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 2048,
    },
    { ...common, id: 'old', model: 'old', cachedTokens: 1024 },
  ]);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ThemeProvider theme="emlight" onThemeChange={() => {}}>
          <GatewayProvidersPanel />
        </ThemeProvider>
      </QueryClientProvider>
    )
  );
  await act(async () => page.getByRole('button', { name: '路由用量' }).click());
  const table = page.getByRole('table', { name: '网关请求用量' });
  await expect.element(table.getByRole('columnheader', { name: '缓存读取' })).toBeVisible();
  await expect.element(table.getByRole('columnheader', { name: '缓存写入' })).toBeVisible();
  const current = table.getByRole('row', { name: /current/ });
  await expect.element(current.getByRole('cell', { name: '0', exact: true })).toBeVisible();
  await expect.element(current.getByRole('cell', { name: '2048', exact: true })).toBeVisible();
  await expect.element(table.getByText('旧版缓存统计（1024）')).toBeVisible();
});
