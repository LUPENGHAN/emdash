import { openFixture } from '@tooling/utils/db';
import { expect, it } from 'vitest';
import { createProviderOverrideSettings } from './provider-settings-service';

it('persists independent agent effort defaults across service recreation and clearing', async () => {
  const fixture = await openFixture('empty');
  try {
    const settings = createProviderOverrideSettings(fixture.db);
    await settings.updateItem('codex', { effort: 'high', contextWindow: 100_000 });
    await settings.updateItem('claude', { effort: 'low' });
    const restored = createProviderOverrideSettings(fixture.db);
    expect(await restored.getItem('codex')).toEqual({ effort: 'high', contextWindow: 100_000 });
    expect(await restored.getItem('claude')).toEqual({ effort: 'low' });
    await restored.updateItem('codex', { effort: undefined, contextWindow: 100_000 });
    expect(await createProviderOverrideSettings(fixture.db).getItem('codex')).toEqual({
      contextWindow: 100_000,
    });
    expect(await createProviderOverrideSettings(fixture.db).getItem('claude')).toEqual({
      effort: 'low',
    });
  } finally {
    fixture.close();
  }
});
