import { Button, Field, Input, toast } from '@emdash/ui/react/primitives';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getRemoteClientClient } from '../api/browser/remote-client';
import {
  REMOTE_CLIENT_STATE_KEY,
  switchComputer,
  useRemoteClientState,
} from '../contributions/browser/connection-switcher';

/** Computers this window can drive, saved on this computer only. */
export function OtherComputersSection() {
  const queryClient = useQueryClient();
  const { data: state } = useRemoteClientState();
  const [link, setLink] = useState('');
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);

  const add = async () => {
    setAdding(true);
    try {
      const server = await (
        await getRemoteClientClient()
      ).addServer({
        link,
        name: name || undefined,
      });
      setLink('');
      setName('');
      toast.success(`Added ${server.name}`);
      void queryClient.invalidateQueries({ queryKey: REMOTE_CLIENT_STATE_KEY });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setAdding(false);
    }
  };

  const servers = state?.servers ?? [];
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Other computers</h3>
        <p className="text-xs text-foreground-muted">
          Drive another computer’s Emdash from this window, like opening its link in a browser but
          with this app’s built-in browser, clipboard and links. Turn on browser access there, copy
          its link and paste it here. Switch in the sidebar.
        </p>
      </div>
      {state?.error ? <p className="text-xs text-foreground-destructive">{state.error}</p> : null}
      {servers.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {servers.map((server) => {
            const inUse = state?.activeServerId === server.id;
            return (
              <li
                key={server.id}
                className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{server.name}</div>
                  <div className="truncate text-xs text-foreground-muted">{server.baseUrl}</div>
                </div>
                {inUse ? (
                  <span className="text-xs text-foreground-muted">In use</span>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void switchComputer(server.id, server.name)}
                  >
                    Use
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void (async () => {
                      await (await getRemoteClientClient()).removeServer({ id: server.id });
                      void queryClient.invalidateQueries({ queryKey: REMOTE_CLIENT_STATE_KEY });
                    })()
                  }
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Field.Group>
        <Field.Root>
          <Field.Label>Link</Field.Label>
          <Input
            value={link}
            placeholder="http://10.147.17.5:7788/connect?token=…"
            onChange={(event) => setLink(event.target.value)}
            className="font-mono text-xs"
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>Name (optional)</Field.Label>
          <Input
            value={name}
            placeholder="Its computer name"
            onChange={(event) => setName(event.target.value)}
          />
        </Field.Root>
        <div>
          <Button variant="secondary" disabled={!link.trim() || adding} onClick={() => void add()}>
            {adding ? 'Checking…' : 'Add computer'}
          </Button>
        </div>
      </Field.Group>
    </section>
  );
}
