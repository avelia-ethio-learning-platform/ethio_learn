import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MobileBuyBar } from './MobileBuyBar';

let notify: (intersecting: boolean) => void;
const observed = new Set<Element>();

beforeEach(() => {
  observed.clear();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
        notify = (isIntersecting) => cb([{ isIntersecting }]);
      }
      observe(el: Element) {
        observed.add(el);
      }
      unobserve(el: Element) {
        observed.delete(el);
      }
      disconnect() {
        observed.clear();
      }
    },
  );
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function mount(boxHtml: string) {
  const box = document.createElement('aside');
  box.id = 'buy-box';
  box.innerHTML = boxHtml;
  document.body.appendChild(box);
  box.scrollIntoView = vi.fn();
  render(<MobileBuyBar targetId="buy-box" price="300 ETB" />);
  act(() => notify(false)); // the buy box scrolled out of view
  return box;
}

describe('MobileBuyBar', () => {
  it('shows the price and mirrors the primary action label, then focuses that action', () => {
    const box = mount('<button data-primary-action="enroll">Buy with Chapa</button>');
    expect(screen.getByText('300 ETB')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Buy with Chapa')[1]);
    expect(box.scrollIntoView).toHaveBeenCalled();
    // the bar's own button and the box's button share a label: the box's one is focused
    expect(document.activeElement).toBe(box.querySelector('[data-primary-action]'));
  });

  it('shows "Continue learning" without the price for an enrolled viewer', () => {
    mount('<button data-primary-action="continue">Continue learning</button>');
    expect(screen.queryByText('300 ETB')).toBeNull();
    expect(screen.getAllByText('Continue learning')).toHaveLength(2);
  });

  it('is not shown when the box has no enabled primary action', () => {
    mount('<button class="btn" disabled>Pay 300 ETB with Chapa</button>');
    expect(screen.queryByText('300 ETB')).toBeNull();
  });

  it('is not shown while the buy box is in view', () => {
    mount('<button data-primary-action="enroll">Buy with Chapa</button>');
    act(() => notify(true));
    expect(screen.queryByText('300 ETB')).toBeNull();
  });

  it('watches the primary action, and moves to the new one when it changes', async () => {
    const box = mount('<button data-primary-action="enroll" id="a">Buy with Chapa</button>');
    const first = box.querySelector('#a')!;
    expect(Array.from(observed)).toEqual([first]);
    box.innerHTML = '<button data-primary-action="enroll" id="b">Redeem coupon</button>';
    const second = box.querySelector('#b')!;
    await waitFor(() => expect(Array.from(observed)).toEqual([second]));
  });

  it('falls back to the whole box when there is no primary action', () => {
    const box = mount('<button class="btn" disabled>Pay</button>');
    expect(Array.from(observed)).toEqual([box]);
  });

  it('scrolls with auto behaviour under reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const box = mount('<button data-primary-action="enroll">Buy with Chapa</button>');
    fireEvent.click(screen.getAllByText('Buy with Chapa')[1]);
    expect(box.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
  });
});
