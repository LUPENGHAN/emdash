import { toast } from '@emdash/ui/react/primitives';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { Requirement } from '../types';
import { getRequirementsClient } from './client';

const requirementsQueryKey = (projectId: string) => ['requirements', projectId] as const;

type RequirementUpdate = {
  id: string;
  title?: string;
  detail?: string;
  status?: Requirement['status'];
};

function showError(error: Error) {
  toast.error(error.message);
}

/** A project's requirements list, refreshed whenever anyone (an agent too) changes it. */
export function useRequirements(projectId: string) {
  const queryClient = useQueryClient();
  const queryKey = requirementsQueryKey(projectId);
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async () => (await getRequirementsClient()).list({ projectId }),
  });

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void getRequirementsClient().then(async (client) => {
      const next = await client.events.subscribe(undefined, {
        onEvent: (event) => {
          if (event.projectId !== projectId) return;
          void queryClient.invalidateQueries({ queryKey: requirementsQueryKey(projectId) });
        },
        onGap: () => {
          void queryClient.invalidateQueries({ queryKey: requirementsQueryKey(projectId) });
        },
      });
      if (disposed) next();
      else unsubscribe = next;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [projectId, queryClient]);

  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const add = useMutation<Requirement, Error, { title: string; detail?: string }>({
    mutationFn: async (input) => (await getRequirementsClient()).add({ projectId, ...input }),
    onSuccess: refresh,
    onError: showError,
  });
  const update = useMutation<Requirement, Error, RequirementUpdate>({
    mutationFn: async (input) => (await getRequirementsClient()).update({ projectId, ...input }),
    onSuccess: refresh,
    onError: showError,
  });
  const remove = useMutation<void, Error, string>({
    mutationFn: async (id) => (await getRequirementsClient()).remove({ projectId, id }),
    onSuccess: refresh,
    onError: showError,
  });

  return {
    items: data ?? [],
    isLoading,
    add: add.mutateAsync,
    isAdding: add.isPending,
    update: update.mutateAsync,
    remove: remove.mutateAsync,
  };
}
