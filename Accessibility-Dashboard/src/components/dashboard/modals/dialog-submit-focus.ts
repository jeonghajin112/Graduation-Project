/** True when focus left the dialog or sits on a control disabled for the request. */
export function isDialogFocusLost(dialog: HTMLElement, active: Element | null): boolean {
  return (
    !(active instanceof HTMLElement) ||
    !dialog.contains(active) ||
    (active as HTMLButtonElement | HTMLInputElement).disabled === true
  );
}
