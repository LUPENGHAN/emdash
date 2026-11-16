import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { getCoordinationClient } from './client';

export function useCoordinators() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['coordinators'],
    queryFn: async () => (await getCoordinationClient()).list(),
  });
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const refresh = () => {
      void client.invalidateQueries({ queryKey: ['coordinators'] });
    };
    void getCoordinationClient()
      .then(async (api) => {
        const next = await api.events.subscribe(undefined, { onEvent: refresh, onGap: refresh });
        if (disposed) next();
        else unsubscribe = next;
      })
      .catch(refresh);
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [client]);
  return query;
}
