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

  it('closes on a touch outside (touchstart), but not on a touch inside', () => {
    render(
      <>
        <Overlay name="A" />
        <p>elsewhere</p>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    fireEvent.touchStart(screen.getByRole('button', { name: 'A inside' }));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    fireEvent.touchStart(screen.getByText('elsewhere'));
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

  it('Escape closes only the innermost of nested overlays, then the outer one', () => {
    function Nested() {
      const [outerOpen, setOuterOpen] = useState(false);
      const [innerOpen, setInnerOpen] = useState(false);
      const outerTrigger = useRef<HTMLButtonElement>(null);
      const outerBox = useRef<HTMLDivElement>(null);
      const innerTrigger = useRef<HTMLButtonElement>(null);
      useDismiss({ open: outerOpen, onClose: () => setOuterOpen(false), containerRef: outerBox, triggerRef: outerTrigger, closeOnOtherOpen: false });
      useDismiss({ open: innerOpen, onClose: () => setInnerOpen(false), containerRef: outerBox, triggerRef: innerTrigger });
      return (
        <div>
          <button ref={outerTrigger} onClick={() => setOuterOpen((o) => !o)}>outer</button>
          {outerOpen && (
            <div ref={outerBox} role="dialog" aria-label="outer panel">
              <button ref={innerTrigger} onClick={() => setInnerOpen((o) => !o)}>inner</button>
              {innerOpen && <div role="dialog" aria-label="inner panel" />}
            </div>
          )}
        </div>
      );
    }
    render(<Nested />);
    const outer = screen.getByRole('button', { name: 'outer' });
    fireEvent.click(outer);
    const inner = screen.getByRole('button', { name: 'inner' });
    fireEvent.click(inner);
    expect(screen.getByRole('dialog', { name: 'inner panel' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'inner panel' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'outer panel' })).toBeTruthy();
    expect(document.activeElement).toBe(inner);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'outer panel' })).toBeNull();
    expect(document.activeElement).toBe(outer);
  });

  it('ignores Escape while closed', () => {
    render(<Overlay name="A" />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(document.activeElement).toBe(document.body);
  });
});
