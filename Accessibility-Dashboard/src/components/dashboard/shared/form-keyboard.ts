import type { KeyboardEvent } from "react";

/** Enter that confirms IME text (including Safari's 229) must not submit. */
export function preventAccidentalSubmit(event: KeyboardEvent<HTMLElement>) {
  if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.repeat)) {
    event.preventDefault();
  }
}
