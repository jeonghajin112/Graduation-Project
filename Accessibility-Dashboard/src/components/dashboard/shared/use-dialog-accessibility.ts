import { useEffect, useRef } from "react";
import type { RefObject } from "react";

let activeBodyScrollLocks = 0;
let bodyOverflowBeforeLock = "";
let bodyPaddingRightBeforeLock = "";

// Open dialogs share one inert lock on the dashboard shell so screen-reader
// browse modes cannot wander into the page behind an aria-modal dialog.
// Dialogs must therefore be portaled outside [data-dashboard-app-shell].
let activeShellInertLocks = 0;
let shellInertBeforeLock = false;
let lockedShell: HTMLElement | null = null;

const APP_SHELL_SELECTOR = "[data-dashboard-app-shell]";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => {
    if (element.hasAttribute("disabled") || element.closest("[aria-hidden='true'], [inert]")) {
      return false;
    }
    // getClientRects() is empty for display:none on the element or any ancestor.
    if (element.getClientRects().length === 0) {
      return false;
    }
    return window.getComputedStyle(element).visibility !== "hidden";
  });
}

function lockBodyScroll() {
  if (activeBodyScrollLocks === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow;
    bodyPaddingRightBeforeLock = document.body.style.paddingRight;

    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
  }

  activeBodyScrollLocks += 1;
}

function unlockBodyScroll() {
  activeBodyScrollLocks = Math.max(0, activeBodyScrollLocks - 1);
  if (activeBodyScrollLocks === 0) {
    document.body.style.overflow = bodyOverflowBeforeLock;
    document.body.style.paddingRight = bodyPaddingRightBeforeLock;
  }
}

function lockAppShell(dialog: HTMLElement) {
  const shell = document.querySelector<HTMLElement>(APP_SHELL_SELECTOR);
  // A dialog rendered inside the shell would disable itself; leave it alone.
  if (!shell || shell.contains(dialog)) {
    return false;
  }
  if (activeShellInertLocks === 0) {
    lockedShell = shell;
    shellInertBeforeLock = shell.inert;
    shell.inert = true;
  }
  activeShellInertLocks += 1;
  return true;
}

function unlockAppShell() {
  activeShellInertLocks = Math.max(0, activeShellInertLocks - 1);
  if (activeShellInertLocks === 0 && lockedShell) {
    lockedShell.inert = shellInertBeforeLock;
    lockedShell = null;
  }
}

export function useDialogAccessibility<TElement extends HTMLElement = HTMLElement>({
  isOpen,
  onClose,
  closeDisabled = false,
  initialFocusRef,
  returnFocusRef,
  getFallbackFocus
}: {
  isOpen: boolean;
  onClose: () => void;
  closeDisabled?: boolean;
  initialFocusRef?: RefObject<HTMLElement>;
  returnFocusRef?: RefObject<HTMLElement>;
  /**
   * Called on close when the element that opened the dialog no longer exists
   * (for example after deleting the row that owned it). Return the next
   * sensible place for keyboard focus so it never falls back to <body>.
   */
  getFallbackFocus?: () => HTMLElement | null | undefined;
}) {
  const dialogRef = useRef<TElement | null>(null);
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  const getFallbackFocusRef = useRef(getFallbackFocus);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    closeDisabledRef.current = closeDisabled;
  }, [closeDisabled]);

  useEffect(() => {
    getFallbackFocusRef.current = getFallbackFocus;
  }, [getFallbackFocus]);

  useEffect(() => {
    if (!isOpen || typeof document === "undefined") {
      return;
    }

    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    const previouslyFocusedElement =
      returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    lockBodyScroll();
    const didLockShell = lockAppShell(dialog);
    const focusTimer = window.setTimeout(() => {
      const [firstFocusableElement] = getFocusableElements(dialog);
      const requestedInitialFocus = initialFocusRef?.current;
      const focusTarget =
        requestedInitialFocus && dialog.contains(requestedInitialFocus)
          ? requestedInitialFocus
          : (firstFocusableElement ?? dialog);
      focusTarget.focus({ preventScroll: true });
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!closeDisabledRef.current) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = getFocusableElements(dialog);
      if (focusableElements.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const firstFocusableElement = focusableElements[0]!;
      const lastFocusableElement = focusableElements[focusableElements.length - 1]!;
      const activeElement = document.activeElement;

      if (!(activeElement instanceof Node) || !dialog.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastFocusableElement : firstFocusableElement).focus({ preventScroll: true });
        return;
      }

      if (event.shiftKey && (activeElement === firstFocusableElement || activeElement === dialog)) {
        event.preventDefault();
        lastFocusableElement.focus({ preventScroll: true });
        return;
      }

      if (!event.shiftKey && activeElement === lastFocusableElement) {
        event.preventDefault();
        firstFocusableElement.focus({ preventScroll: true });
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      unlockBodyScroll();
      if (didLockShell) {
        unlockAppShell();
      }
      if (previouslyFocusedElement && document.contains(previouslyFocusedElement)) {
        previouslyFocusedElement.focus({ preventScroll: true });
        return;
      }
      // The opener was removed together with the data it represented. Wait for
      // React to commit the replacement list before choosing the next target.
      window.requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body && document.contains(active)) {
          return;
        }
        const fallback = getFallbackFocusRef.current?.();
        const target =
          fallback && document.contains(fallback)
            ? fallback
            : document.querySelector<HTMLElement>("#dashboard-main-content, main");
        target?.focus({ preventScroll: true });
      });
    };
  }, [initialFocusRef, isOpen, returnFocusRef]);

  return dialogRef;
}
