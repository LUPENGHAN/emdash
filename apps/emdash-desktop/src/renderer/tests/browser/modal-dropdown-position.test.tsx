import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { Combobox, Dialog, Select } from '@emdash/ui/react/primitives';
import '@emdash/ui/style.css';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function ancestorChain(element: HTMLElement | null) {
  const chain: Array<Record<string, string>> = [];
  let node: HTMLElement | null = element;
  while (node && node !== document.body) {
    const computed = getComputedStyle(node);
    chain.push({
      tag: node.tagName,
      slot: node.getAttribute('data-slot') ?? '',
      position: computed.position,
      transform: computed.transform,
      overflow: computed.overflow,
      inlineTop: node.style.top,
      inlineLeft: node.style.left,
      inlineBottom: node.style.bottom,
    });
    node = node.parentElement;
  }
  return chain;
}

describe('dropdowns inside dialogs', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await page.viewport(1024, 800);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('opens a select next to its trigger inside a translate-centered modal', async () => {
    await act(async () => {
      root.render(
        <DialogPrimitive.Root open>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Popup
              data-slot="dialog-content"
              style={{
                position: 'fixed',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                zIndex: 50,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                width: '28rem',
                height: '28rem',
                padding: '1rem',
                background: 'white',
              }}
            >
              <Select.Root open value="alpha">
                <Select.Trigger>
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="alpha">Alpha</Select.Item>
                  <Select.Item value="bravo">Bravo</Select.Item>
                  <Select.Item value="charlie">Charlie</Select.Item>
                </Select.Content>
              </Select.Root>
            </DialogPrimitive.Popup>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const trigger = document.querySelector<HTMLElement>('[data-slot="select-trigger"]');
    const popup = document.querySelector<HTMLElement>('[data-slot="select-content"]');
    const positioner = popup?.parentElement ?? null;
    const triggerRect = trigger?.getBoundingClientRect();
    const popupRect = popup?.getBoundingClientRect();
    const detail = JSON.stringify(
      {
        triggerRect,
        popupRect,
        positionerStyle: positioner?.getAttribute('style'),
        ancestors: ancestorChain(popup),
      },
      null,
      2
    );

    expect(trigger, detail).not.toBeNull();
    expect(popup, detail).not.toBeNull();
    const gap = Math.min(
      Math.abs(popupRect!.top - triggerRect!.bottom),
      Math.abs(popupRect!.bottom - triggerRect!.top)
    );
    expect(gap, detail).toBeLessThan(48);
    expect(popupRect!.top, detail).toBeGreaterThanOrEqual(0);
    expect(popupRect!.bottom, detail).toBeLessThanOrEqual(window.innerHeight);

    const item = popup!.querySelector<HTMLElement>('[data-slot="select-item"]');
    const itemRect = item!.getBoundingClientRect();
    const hit = document.elementFromPoint(
      itemRect.left + itemRect.width / 2,
      itemRect.top + itemRect.height / 2
    );
    expect(
      item!.contains(hit) || hit === item,
      `${detail}\nhit=${hit?.outerHTML?.slice(0, 200)}`
    ).toBe(true);
  });

  it('opens a select next to its trigger inside the grid-centered dialog', async () => {
    await act(async () => {
      root.render(
        <Dialog.Root open>
          <Dialog.Content>
            <Select.Root open value="alpha">
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="alpha">Alpha</Select.Item>
                <Select.Item value="bravo">Bravo</Select.Item>
              </Select.Content>
            </Select.Root>
          </Dialog.Content>
        </Dialog.Root>
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const trigger = document.querySelector<HTMLElement>('[data-slot="select-trigger"]');
    const popup = document.querySelector<HTMLElement>('[data-slot="select-content"]');
    const triggerRect = trigger?.getBoundingClientRect();
    const popupRect = popup?.getBoundingClientRect();
    const detail = JSON.stringify(
      { triggerRect, popupRect, ancestors: ancestorChain(popup) },
      null,
      2
    );

    expect(trigger, detail).not.toBeNull();
    expect(popup, detail).not.toBeNull();
    const gap = Math.min(
      Math.abs(popupRect!.top - triggerRect!.bottom),
      Math.abs(popupRect!.bottom - triggerRect!.top)
    );
    expect(gap, detail).toBeLessThan(48);
  });

  it('opens a combobox next to its trigger inside a translate-centered modal', async () => {
    await act(async () => {
      root.render(
        <DialogPrimitive.Root open>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Popup
              style={{
                position: 'fixed',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                zIndex: 50,
                overflow: 'hidden',
                width: '28rem',
                height: '28rem',
                padding: '1rem',
                background: 'white',
              }}
            >
              <Combobox.Root open items={['Claude Code', 'Grok']}>
                <Combobox.Trigger>Claude Code</Combobox.Trigger>
                <Combobox.Content>
                  <Combobox.Input showTrigger={false} />
                  <Combobox.List>
                    {(item: string) => (
                      <Combobox.Item key={item} value={item}>
                        {item}
                      </Combobox.Item>
                    )}
                  </Combobox.List>
                </Combobox.Content>
              </Combobox.Root>
            </DialogPrimitive.Popup>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const trigger = document.querySelector<HTMLElement>('[data-slot="combobox-trigger"]');
    const popup = document.querySelector<HTMLElement>('[data-slot="combobox-content"]');
    const triggerRect = trigger?.getBoundingClientRect();
    const popupRect = popup?.getBoundingClientRect();
    const detail = JSON.stringify(
      {
        triggerRect,
        popupRect,
        positionerStyle: popup?.parentElement?.getAttribute('style'),
        ancestors: ancestorChain(popup),
      },
      null,
      2
    );

    expect(trigger, detail).not.toBeNull();
    expect(popup, detail).not.toBeNull();
    const gap = Math.min(
      Math.abs(popupRect!.top - triggerRect!.bottom),
      Math.abs(popupRect!.bottom - triggerRect!.top)
    );
    expect(gap, detail).toBeLessThan(48);

    const item = popup!.querySelector<HTMLElement>('[data-slot="combobox-item"]');
    const itemRect = item!.getBoundingClientRect();
    const hit = document.elementFromPoint(
      itemRect.left + itemRect.width / 2,
      itemRect.top + itemRect.height / 2
    );
    expect(item!.contains(hit) || hit === item, detail).toBe(true);
  });
});
