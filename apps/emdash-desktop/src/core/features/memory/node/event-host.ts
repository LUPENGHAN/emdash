import { createEventStreamHost } from '@emdash/wire/live';
import { memoryContract } from '../api/contract';

export const memoryEvents = createEventStreamHost(memoryContract.events);
