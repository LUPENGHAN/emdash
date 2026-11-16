import { createEventStreamHost } from '@emdash/wire/live';
import { coordinationContract } from '../api/contract';

export const coordinationEvents = createEventStreamHost(coordinationContract.events);
