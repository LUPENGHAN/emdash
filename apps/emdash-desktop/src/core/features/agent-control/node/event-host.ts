import { createEventStreamHost } from '@emdash/wire/live';
import { agentControlContract } from '../api';

export const agentControlEvents = createEventStreamHost(agentControlContract.requests);

export const agentMessageEvents = createEventStreamHost(agentControlContract.messagesChanged);
