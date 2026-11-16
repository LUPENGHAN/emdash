import { Button, toast } from '@emdash/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useTaskViewContext } from '@core/features/tasks/contributions/browser/task-view-context';
import { getAgentControlClient } from '../api/browser/client';

export function PendingMessagesPanel({ children }: { children: ReactNode }) {
  const { taskId } = useTaskViewContext();
  const cache = useQueryClient();
  const key = ['pending-agent-messages', taskId];
  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const query = useQuery({
    queryKey: key,
    queryFn: async () => (await getAgentControlClient()).pendingMessages({ taskId }),
  });
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const refresh = () => {
      void cache.invalidateQueries({ queryKey: ['pending-agent-messages', taskId] });
    };
    void getAgentControlClient()
      .then(async (client) => {
        const stop = await client.messagesChanged.subscribe(undefined, {
          onEvent: (event) => {
            if (event.taskId === taskId) refresh();
          },
          onGap: refresh,
        });
        if (disposed) stop();
        else unsubscribe = stop;
      })
      .catch((error) =>
        toast.error('Could not subscribe to pending messages', { description: String(error) })
      );
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [taskId, cache]);
  const resolve = async (id: string, resolution: 'handled' | 'dismissed') => {
    setResolving(id);
    try {
      await (await getAgentControlClient()).resolvePendingMessage({ taskId, id, resolution });
      await cache.invalidateQueries({ queryKey: key });
    } catch (error) {
      toast.error('Could not update pending message', { description: String(error) });
    } finally {
      setResolving(null);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      {query.isError ? (
        <div className="shrink-0 border-b border-border px-3 py-1 text-sm">
          <p>
            {query.error instanceof Error
              ? query.error.message
              : 'Pending messages are unavailable.'}
          </p>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              void query.refetch();
            }}
          >
            Retry loading pending messages
          </Button>
        </div>
      ) : (
        !!query.data?.length && (
          <div
            className="max-h-[40%] shrink-0 overflow-auto border-b border-border px-3 py-1"
            data-testid="pending-agent-messages"
          >
            <Button type="button" variant="ghost" onClick={() => setOpen(!open)}>
              Pending messages ({query.data.length})
            </Button>
            {open &&
              query.data.map((message) => (
                <article
                  key={message.id}
                  className="my-2 space-y-2 rounded border border-border p-3 text-sm"
                >
                  <p>
                    {message.title} ·{' '}
                    {message.status === 'delivery_unknown' ? 'Delivery unknown' : 'Not delivered'}
                  </p>
                  {message.reason && <p className="text-foreground-muted">{message.reason}</p>}
                  <pre className="max-h-40 overflow-auto font-sans break-words whitespace-pre-wrap">
                    {message.text}
                  </pre>
                  <p className="text-xs text-foreground-muted">
                    Check the target conversation before repeating a message. Copy it there if
                    needed, then mark it handled.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(message.text)
                          .catch((error) =>
                            toast.error('Could not copy message', { description: String(error) })
                          );
                      }}
                    >
                      Copy message
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={resolving !== null}
                      onClick={() => {
                        void resolve(message.id, 'handled');
                      }}
                    >
                      Mark handled
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={resolving !== null}
                      onClick={() => {
                        void resolve(message.id, 'dismissed');
                      }}
                    >
                      Dismiss
                    </Button>
                  </div>
                </article>
              ))}
          </div>
        )
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
