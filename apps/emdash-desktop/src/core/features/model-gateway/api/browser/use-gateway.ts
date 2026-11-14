import { useQuery } from '@tanstack/react-query';
import { getModelGatewayClient } from './client';

export function useGatewayStatus() {
  return useQuery({
    queryKey: ['modelGateway', 'status'],
    queryFn: async () => (await getModelGatewayClient()).status(),
    refetchInterval: 5000,
  });
}
