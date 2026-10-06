import type { MouseEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { nextMenuItemIndex, openAfterContextMenuRelease } from "./menu-keyboard";

describe("nextMenuItemIndex", () => {
  it("wraps arrow navigation in both directions", () => {
    expect(nextMenuItemIndex("ArrowDown", 1, 2)).toBe(0);
    expect(nextMenuItemIndex("ArrowUp", 0, 2)).toBe(1);
  });

  it("starts from the edge when focus is outside the menu", () => {
    expect(nextMenuItemIndex("ArrowDown", -1, 3)).toBe(0);
    expect(nextMenuItemIndex("ArrowUp", -1, 3)).toBe(2);
  });

  it("jumps with Home and End and ignores other keys", () => {
    expect(nextMenuItemIndex("Home", 2, 3)).toBe(0);
    expect(nextMenuItemIndex("End", 0, 3)).toBe(2);
    expect(nextMenuItemIndex("Enter", 0, 3)).toBeNull();
    expect(nextMenuItemIndex("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("openAfterContextMenuRelease", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const contextMenu = (buttons: number) => ({ buttons }) as MouseEvent<HTMLElement>;

  it("opens at once when contextmenu fires after the release", () => {
    const open = vi.fn();
    openAfterContextMenuRelease(contextMenu(0), open);
    expect(open).toHaveBeenCalledOnce();
  });

  it("waits for the release when contextmenu fires on press", () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    vi.stubGlobal("window", Object.assign(target, {
      setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay)
    }));
    const open = vi.fn();
    openAfterContextMenuRelease(contextMenu(2), open);
    vi.runAllTimers();
    expect(open).not.toHaveBeenCalled();
    target.dispatchEvent(new Event("pointerup"));
    expect(open).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(open).toHaveBeenCalledOnce();
    target.dispatchEvent(new Event("pointerup"));
    vi.runAllTimers();
    expect(open).toHaveBeenCalledOnce();
  });
});
