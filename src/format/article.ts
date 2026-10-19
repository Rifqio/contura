// "a" or "an" by how the word sounds, not how it is spelled: a user, a unit, a euro, an hour.

/**
 * Spelled with a vowel but said with a consonant: "you" (user, unit, uuid; uni- but not un-in, un-im,
 * un-id as in uninstall), "yoo" (euro), "w" (one, one_time, once; not onion).
 */
const CONSONANT_SOUND = /^(uni(?![nmd])|use|usa|usu|uti|uuid|uri|url|ure|euro|eu|ewe|one(?![a-z])|once)/i;
/** Spelled with a consonant but said with a vowel: a silent h. */
const VOWEL_SOUND = /^(hour|honest|honou?r|heir)/i;

export function article(word: string): string {
  if (VOWEL_SOUND.test(word)) return `an ${word}`;
  if (CONSONANT_SOUND.test(word)) return `a ${word}`;
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}
