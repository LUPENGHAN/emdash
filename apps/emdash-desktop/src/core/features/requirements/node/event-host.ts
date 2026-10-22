import { createEventStreamHost } from '@emdash/wire/live';
import { requirementsContract } from '../api/contract';

export const requirementsEvents = createEventStreamHost(requirementsContract.events);
