import { z } from 'zod';

export const pendingAgentMessageSchema = z.object({
  id: z.string(),
  promptId: z.string(),
  conversationId: z.string(),
  title: z.string(),
  text: z.string(),
  status: z.enum(['pending', 'delivery_unknown']),
  reason: z.string().optional(),
});
export type PendingAgentMessage = z.infer<typeof pendingAgentMessageSchema>;
export type PendingAgentMessages = {
  list(taskId: string): Promise<PendingAgentMessage[]>;
  resolve(taskId: string, id: string, resolution: 'handled' | 'dismissed'): Promise<void>;
};
