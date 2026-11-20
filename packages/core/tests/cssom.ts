/**
 * Serialise a CSS value through the CSSOM the test is running against.
 *
 * `element.style.x` returns the CSSOM's SERIALISATION of what the engine wrote,
 * not the string it wrote. jsdom 30 (via cssstyle) echoed most values back
 * verbatim, so tests compared against hand-built literals such as
 * `translate3d(90px,0px,0)` or `66.66666666666666%`. jsdom 31 replaced cssstyle
 * with an integrated CSSOM that normalises the way browsers do — numbers to six
 * significant digits, transform arguments comma-and-space separated with
 * explicit units — so those literals stopped matching values that were never
 * wrong. Its release notes say so: "CSS serialization and computed values can
 * differ from previous releases."
 *
 * Round-tripping the EXPECTED literal through the same CSSOM keeps the
 * assertions exact (`toBe`, not a tolerance) and independent of which DOM
 * implementation is installed: two values compare equal only when this CSSOM
 * would serialise them identically.
 *
 * Throws when the CSSOM rejects the value. Without that, an invalid expected
 * literal serialises to `''` and would match an engine that wrote nothing.
 */
export function cssValue(property: string, value: string): string {
  const probe = document.createElement('div');
  probe.style.setProperty(property, value);
  const serialised = probe.style.getPropertyValue(property);
  if (serialised === '') {
    throw new Error(`cssValue: the CSSOM rejected ${property}: ${value}`);
  }
  return serialised;
}
