import type { KeyboardEvent } from "react";

/**
 * WAI-ARIA menu keyboard model: ArrowUp/ArrowDown wrap, Home/End jump.
 * Returns null for keys a menu does not handle.
 */
export function nextMenuItemIndex(key: string, currentIndex: number, itemCount: number): number | null {
  if (itemCount <= 0) {
    return null;
  }
  if (key === "ArrowDown") {
    return currentIndex < 0 ? 0 : (currentIndex + 1) % itemCount;
  }
  if (key === "ArrowUp") {
    return currentIndex < 0 ? itemCount - 1 : (currentIndex - 1 + itemCount) % itemCount;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return itemCount - 1;
  }
  return null;
}

export function handleMenuArrowKeys(event: KeyboardEvent<HTMLElement>) {
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')
  );
  const currentIndex = items.findIndex((item) => item === document.activeElement);
  const nextIndex = nextMenuItemIndex(event.key, currentIndex, items.length);
  if (nextIndex === null) {
    return;
  }
  event.preventDefault();
  items[nextIndex]?.focus({ preventScroll: true });
}
