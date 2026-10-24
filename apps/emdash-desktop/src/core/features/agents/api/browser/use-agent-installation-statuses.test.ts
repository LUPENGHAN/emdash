import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { describe, expect, it } from 'vitest';
import {
  agentInstallationStatusQueryConfig,
  agentStatusInvalidationFilters,
} from './use-agent-installation-statuses';

describe('agent installation status queries', () => {
  it('does not poll unless the caller passes an interval', () => {
    expect(agentInstallationStatusQueryConfig()).toEqual({ staleTime: 30_000 });
    expect(agentInstallationStatusQueryConfig()).not.toHaveProperty('refetchInterval');
    expect(agentInstallationStatusQueryConfig(60_000)).toEqual({
      staleTime: 30_000,
      refetchInterval: 60_000,
    });
  });

  it('drops the status and metadata queries together', () => {
    expect(agentStatusInvalidationFilters(LOCAL_HOST_REF)).toEqual([
      { queryKey: ['agents', 'status', 'local:local'] },
      { queryKey: ['agents', 'metadata', 'local:local'] },
    ]);
  });
});
