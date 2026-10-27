import { toast } from '@emdash/ui/react/primitives';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { MemoryChanges, MemoryRecord, MemoryScope } from '../types';
import { getMemoryClient } from './client';

function scopeKey(scope: MemoryScope): string {
  return scope.kind === 'project' ? scope.projectId : 'global';
}

function queryKeyFor(scope: MemoryScope) {
  return ['memory', scope.kind, scopeKey(scope)] as const;
}

function wireScope(scope: MemoryScope) {
  return scope.kind === 'project'
    ? { scope: 'project' as const, projectId: scope.projectId }
    : { scope: 'global' as const };
}

function sameList(scope: MemoryScope, event: { scope: 'project' | 'global'; projectId?: string }) {
  if (scope.kind === 'global') return event.scope === 'global';
  return event.scope === 'project' && event.projectId === scope.projectId;
}

function showError(error: Error) {
  toast.error(error.message);
}

/** One decision list, refreshed when the user or an agent changes it. */
export function useMemory(scope: MemoryScope) {
  const queryClient = useQueryClient();
  const kind = scope.kind;
  const projectId = scope.kind === 'project' ? scope.projectId : '';
  const currentScope: MemoryScope =
    kind === 'project' ? { kind: 'project', projectId } : { kind: 'global' };
  const queryKey = queryKeyFor(currentScope);
  const query = useQuery({
    queryKey,
    queryFn: async () => (await getMemoryClient()).list(wireScope(currentScope)),
  });

  useEffect(() => {
    const watched: MemoryScope =
      kind === 'project' ? { kind: 'project', projectId } : { kind: 'global' };
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void getMemoryClient().then(async (client) => {
      const next = await client.events.subscribe(undefined, {
        onEvent: (event) => {
          if (!sameList(watched, event)) return;
          void queryClient.invalidateQueries({ queryKey: queryKeyFor(watched) });
        },
        onGap: () => {
          void queryClient.invalidateQueries({ queryKey: queryKeyFor(watched) });
        },
      });
      if (disposed) next();
      else unsubscribe = next;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [kind, projectId, queryClient]);

  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const add = useMutation<MemoryRecord, Error, { title: string; detail?: string }>({
    mutationFn: async (input) => (await getMemoryClient()).add({ ...wireScope(scope), ...input }),
    onSuccess: refresh,
    onError: showError,
  });
  const update = useMutation<MemoryRecord, Error, { id: string } & MemoryChanges>({
    mutationFn: async (input) =>
      (await getMemoryClient()).update({ ...wireScope(scope), ...input }),
    onSuccess: refresh,
    onError: showError,
  });
  const remove = useMutation<void, Error, string>({
    mutationFn: async (id) => (await getMemoryClient()).remove({ ...wireScope(scope), id }),
    onSuccess: refresh,
    onError: showError,
  });

  return {
    items: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    add: add.mutateAsync,
    isAdding: add.isPending,
    update: update.mutateAsync,
    remove: remove.mutateAsync,
  };
}
