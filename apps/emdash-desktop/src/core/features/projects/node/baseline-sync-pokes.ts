import { pokeChannel } from '@emdash/wire/state';

export const baselineSyncPokes = pokeChannel<{ projectId: string }>('project-baselines');
