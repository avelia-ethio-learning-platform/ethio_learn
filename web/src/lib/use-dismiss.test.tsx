import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { useDismiss } from './use-dismiss';

function Overlay({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useDismiss({ open, onClose: () => setOpen(false), containerRef, triggerRef });
  return (
    <div>
      <button ref={triggerRef} onClick={() => setOpen((o) => !o)}>
        {name}
      </button>
      {open && (
        <div ref={containerRef} role="dialog" aria-label={`${name} panel`}>
          <button>{name} inside</button>
        </div>
      )}
    </div>
  );
}

afterEach(cleanup);

describe('useDismiss', () => {
  it('closes on Escape and returns focus to the trigger', () => {
    render(<Overlay name="A" />);
    const trigger = screen.getByRole('button', { name: 'A' });
    fireEvent.click(trigger);
    screen.getByRole('button', { name: 'A inside' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on an outside click but not on a click inside or on the trigger', () => {
    render(
      <>
        <Overlay name="A" />
        <p>elsewhere</p>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    fireEvent.mouseDown(screen.getByRole('button', { name: 'A inside' }));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'A' }));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    fireEvent.mouseDown(screen.getByText('elsewhere'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes when a second overlay opens, and not because of its own opening', () => {
    render(
      <>
        <Overlay name="A" />
        <Overlay name="B" />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    expect(screen.getByRole('dialog', { name: 'A panel' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'B' }));
    expect(screen.queryByRole('dialog', { name: 'A panel' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'B panel' })).toBeTruthy();
  });

  it('broadcasts el-overlay-open with an id when opening', () => {
    const seen = vi.fn();
    const listener = (e: Event) => seen((e as CustomEvent).detail);
    window.addEventListener('el-overlay-open', listener);
    render(<Overlay name="A" />);
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    window.removeEventListener('el-overlay-open', listener);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(typeof seen.mock.calls[0][0]).toBe('string');
  });

  it('ignores Escape while closed', () => {
    render(<Overlay name="A" />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(document.activeElement).toBe(document.body);
  });
});
