import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgentSettings } from '@core/features/agents/api/browser/use-agent-settings';
import { isProviderCapableAgent, type ModelSourceValue } from '../index';

/** Resolve defaults before rendering model controls or freezing a new conversation choice. */
export function useModelSource(
  agent: string | null | undefined,
  value: ModelSourceValue,
  remote = false
): ModelSourceValue {
  const { value: defaults, isLoading } = useAgentSettings(
    agent ?? '',
    hostRefFromConnectionId(),
    Boolean(agent && isProviderCapableAgent(agent) && !remote)
  );
  if (value.modelSource !== undefined || remote) return value;
  if (defaults?.modelSource)
    return { modelSource: defaults.modelSource, sourceModel: defaults.sourceModel };
  return !isLoading && agent && isProviderCapableAgent(agent) ? { modelSource: null } : value;
}
