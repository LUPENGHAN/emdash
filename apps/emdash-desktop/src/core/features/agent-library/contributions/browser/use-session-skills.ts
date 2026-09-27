import { useQuery } from '@tanstack/react-query';
import { getAgentLibraryClient } from '../../api/browser/client';

/** The library skills an agent in this project gets (shown in the chat composer). */
export function useSessionSkills(
  projectId: string | null
): { name: string; description: string }[] {
  const { data } = useQuery({
    queryKey: ['agentLibrary', 'effective', projectId],
    queryFn: async () => (await getAgentLibraryClient()).effectiveFor({ projectId }),
    staleTime: 30_000,
  });
  return data?.skills ?? [];
}
