/**
 * JD's out-for-delivery wording names the courier and gives their phone in
 * brackets: "the courier is 【name，phone】,". The clause is dropped and the
 * rest of the sentence kept.
 */
const COURIER_CONTACT = /\s*the courier is\s*【[^】]*】\s*,?/i;

export function withoutCourierContact(text: string): string {
  return text.replace(COURIER_CONTACT, '').replace(/\s+/g, ' ').trim();
}
