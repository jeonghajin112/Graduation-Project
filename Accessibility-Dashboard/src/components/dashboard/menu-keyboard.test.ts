import { describe, expect, it } from "vitest";

import { nextMenuItemIndex } from "./menu-keyboard";

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
