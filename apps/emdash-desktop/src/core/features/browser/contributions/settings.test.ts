import { describe, expect, it } from 'vitest';
import { browserSettingsContribution } from './settings';

describe('browserSettingsContribution', () => {
  const defaults = browserSettingsContribution.defaults as {
    agentOpensInBackground: boolean;
  };

  it('keeps agents switching to the browser by default', () => {
    expect(defaults.agentOpensInBackground).toBe(false);
    expect(browserSettingsContribution.schema.safeParse(defaults).success).toBe(true);
  });

  it('accepts turning background opening on', () => {
    const parsed = browserSettingsContribution.schema.safeParse({
      ...defaults,
      agentOpensInBackground: true,
    });
    expect(parsed.success && parsed.data.agentOpensInBackground).toBe(true);
  });
});
