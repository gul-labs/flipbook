/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Interactive targets that should not start a page fold (UX-003). */
export const FLIPBOOK_INTERACTIVE_SELECTOR =
  'a[href],button,input,textarea,select,summary,label,[contenteditable],[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=slider],[role=textbox],[role=combobox],video[controls],audio[controls],iframe,embed,object';

export function isInteractivePointerTarget(t: EventTarget | null): boolean {
  return t instanceof Element && !!t.closest(FLIPBOOK_INTERACTIVE_SELECTOR);
}
