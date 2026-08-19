import { useEffect, useRef } from "react";
import type { RefObject } from "react";

let activeBodyScrollLocks = 0;
let bodyOverflowBeforeLock = "";
let bodyPaddingRightBeforeLock = "";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => {
    const style = window.getComputedStyle(element);
    return (
      !element.hasAttribute("disabled") &&
      element.getAttribute("aria-hidden") !== "true" &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
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

export function useDialogAccessibility<TElement extends HTMLElement = HTMLElement>({
  isOpen,
  onClose,
  closeDisabled = false,
  initialFocusRef,
  returnFocusRef
}: {
  isOpen: boolean;
  onClose: () => void;
  closeDisabled?: boolean;
  initialFocusRef?: RefObject<HTMLElement>;
  returnFocusRef?: RefObject<HTMLElement>;
}) {
  const dialogRef = useRef<TElement | null>(null);
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    closeDisabledRef.current = closeDisabled;
  }, [closeDisabled]);

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

      if (event.shiftKey && activeElement === firstFocusableElement) {
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
      if (previouslyFocusedElement && document.contains(previouslyFocusedElement)) {
        previouslyFocusedElement.focus({ preventScroll: true });
      }
    };
  }, [initialFocusRef, isOpen, returnFocusRef]);

  return dialogRef;
}
