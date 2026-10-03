'use client';

import { useEffect, useId, useRef, type RefObject } from 'react';

export const OVERLAY_OPEN_EVENT = 'el-overlay-open';

interface UseDismissOptions {
  open: boolean;
  onClose: () => void;
  containerRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
  /** Set false for an overlay that hosts other overlays (the mobile menu holds the theme menu). */
  closeOnOtherOpen?: boolean;
}

/**
 * Shared dismissal for popovers and menus: outside click, Escape (focus goes
 * back to the trigger), and closing when another overlay opens. Opening is
 * broadcast on `window` with the instance id; an overlay ignores its own.
 */
export function useDismiss({ open, onClose, containerRef, triggerRef, closeOnOtherOpen = true }: UseDismissOptions) {
  const id = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent(OVERLAY_OPEN_EVENT, { detail: id }));

    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (containerRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onCloseRef.current();
      triggerRef.current?.focus();
    };
    const onOtherOpen = (e: Event) => {
      if (!closeOnOtherOpen || (e as CustomEvent<string>).detail === id) return;
      onCloseRef.current();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener(OVERLAY_OPEN_EVENT, onOtherOpen);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OVERLAY_OPEN_EVENT, onOtherOpen);
    };
  }, [open, id, containerRef, triggerRef, closeOnOtherOpen]);
}
