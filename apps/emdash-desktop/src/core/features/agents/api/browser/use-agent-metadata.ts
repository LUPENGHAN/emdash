import { useQuery } from '@tanstack/react-query';
import { getAgentsClient } from '@core/features/agents/api/browser/client';
import type { AgentMetadata } from '@core/primitives/agents/api';

export const AGENT_STATIC_METADATA_QUERY_KEY = ['agents', 'static-metadata'] as const;

/**
 * Static plugin-registry metadata (icons, display names, capabilities schema).
 * Host-independent by construction — use this for display-only consumers so the
 * host-carrying hooks (`useAgents` et al.) can require a host without exceptions.
 * Refreshed now and then: Codex's model list follows what OpenAI offers the account.
 */
export function useAgentMetadata() {
  return useQuery<AgentMetadata[]>({
    queryKey: AGENT_STATIC_METADATA_QUERY_KEY,
    queryFn: async () => (await getAgentsClient()).listMetadata(undefined),
    staleTime: 5 * 60_000,
  });
}

export function useAgentIcon(id: string) {
  const { data: agents } = useAgentMetadata();
  return agents?.find((candidate) => candidate.id === id)?.icon ?? null;
}
