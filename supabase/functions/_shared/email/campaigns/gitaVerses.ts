/**
 * Short, original English renderings of selected Bhagavad Gita verses.
 *
 * These are paraphrases for campaign use, not copied modern translations.
 * The chapter/verse references were checked against standard Gita verse
 * indexes; the test suite also verifies that every reference is in range and
 * that the pool contains no duplicate reference.
 */
export interface GitaVerse {
  chapter: number;
  verse: number;
  rendering: string;
}

export const GITA_VERSES: readonly GitaVerse[] = [
  { chapter: 2, verse: 14, rendering: 'Comfort and discomfort come and go; meet them with patience.' },
  { chapter: 2, verse: 20, rendering: 'The deepest Self is not born, nor does it ever perish.' },
  { chapter: 2, verse: 47, rendering: 'Your role is action; its fruits are not yours to claim.' },
  { chapter: 2, verse: 48, rendering: 'Stand steady in yoga, releasing attachment to success and failure.' },
  { chapter: 2, verse: 50, rendering: 'Yoga is skill in action: act with a clear and balanced mind.' },
  { chapter: 2, verse: 70, rendering: 'Peace comes to the one who remains full yet unmoved, like the ocean.' },
  { chapter: 3, verse: 7, rendering: 'Guide the senses with the mind, and engage in selfless action.' },
  { chapter: 3, verse: 19, rendering: 'Keep doing what must be done, without clinging to the result.' },
  { chapter: 3, verse: 30, rendering: 'Offer every action to the highest, free from possessiveness and inner fever.' },
  { chapter: 4, verse: 7, rendering: 'Whenever harmony declines, the divine presence appears to restore it.' },
  { chapter: 4, verse: 8, rendering: 'The divine protects what is good, transforms harm, and renews dharma.' },
  { chapter: 4, verse: 34, rendering: 'Learn through humility, sincere questions, and service to the wise.' },
  { chapter: 4, verse: 38, rendering: 'Nothing purifies the heart like knowledge discovered through practice.' },
  { chapter: 5, verse: 10, rendering: 'Offer actions without attachment, as a lotus remains untouched by water.' },
  { chapter: 5, verse: 18, rendering: 'The wise see the same sacred reality in every being.' },
  { chapter: 5, verse: 22, rendering: 'Pleasures born of contact begin and end; they do not hold lasting joy.' },
  { chapter: 5, verse: 29, rendering: 'Knowing the divine as friend of all beings, one finds deep peace.' },
  { chapter: 6, verse: 5, rendering: 'Lift yourself by your own mind; let it become your friend, not your adversary.' },
  { chapter: 6, verse: 6, rendering: 'For one who has mastered the mind, it is a faithful friend.' },
  { chapter: 6, verse: 16, rendering: 'Yoga is not found in excess, nor in neglect of food, sleep, or effort.' },
  { chapter: 6, verse: 17, rendering: 'Balanced living in food, rest, work, and reflection eases suffering.' },
  { chapter: 6, verse: 26, rendering: 'Whenever the wandering mind moves away, gently bring it back.' },
  { chapter: 6, verse: 29, rendering: 'The yogi sees the Self present in all beings and all beings within the Self.' },
  { chapter: 6, verse: 32, rendering: 'The finest understanding is to feel another’s joy and sorrow as one’s own.' },
  { chapter: 6, verse: 35, rendering: 'The restless mind is steadied by practice and by letting go.' },
  { chapter: 6, verse: 47, rendering: 'Among yogis, the deepest union belongs to the one who trusts with a devoted heart.' },
  { chapter: 7, verse: 7, rendering: 'All things are strung on the divine like pearls on a thread.' },
  { chapter: 7, verse: 14, rendering: 'This changing power is difficult to cross; refuge in the divine carries one across.' },
  { chapter: 7, verse: 19, rendering: 'After many lives of insight, the wise recognize that all is rooted in the One.' },
  { chapter: 8, verse: 7, rendering: 'Remember the highest and continue your duty; the two can live together.' },
  { chapter: 9, verse: 22, rendering: 'Those who remain devoted and undivided are cared for in what they need.' },
  { chapter: 9, verse: 26, rendering: 'A leaf, flower, fruit, or water is received when offered with devotion.' },
  { chapter: 9, verse: 27, rendering: 'Whatever you do, eat, offer, or give, let it become an offering.' },
  { chapter: 10, verse: 20, rendering: 'The divine Self dwells in the heart of every being.' },
  { chapter: 10, verse: 41, rendering: 'Whatever is radiant, strong, or beautiful shines with a spark of the divine.' },
  { chapter: 11, verse: 55, rendering: 'Work for the highest, make it your aim, release attachment, and meet all without hostility.' },
  { chapter: 12, verse: 6, rendering: 'Those who offer every action and hold the highest as their refuge are held close.' },
  { chapter: 12, verse: 13, rendering: 'One dear to the divine is kind to all, free from hatred, and gentle in heart.' },
  { chapter: 12, verse: 15, rendering: 'One who neither disturbs the world nor is disturbed by it lives in freedom.' },
  { chapter: 12, verse: 18, rendering: 'The steady-hearted meet friend and foe, honor and blame, alike.' },
  { chapter: 12, verse: 20, rendering: 'Those who live this path of devotion with trust are especially dear.' },
  { chapter: 13, verse: 8, rendering: 'Humility, sincerity, patience, and nonviolence are signs of true understanding.' },
  { chapter: 14, verse: 22, rendering: 'The wise neither hate clarity, activity, or inertia when they appear, nor crave them when absent.' },
  { chapter: 15, verse: 7, rendering: 'Every living being carries an eternal spark of the divine.' },
  { chapter: 15, verse: 15, rendering: 'The divine lives in every heart, giving memory, insight, and the power to understand.' },
  { chapter: 16, verse: 21, rendering: 'Desire, anger, and greed are three gates that lead away from inner freedom.' },
  { chapter: 18, verse: 46, rendering: 'Through one’s own work, offered sincerely, the source of all can be honored.' },
  { chapter: 18, verse: 66, rendering: 'Set down every burden and take refuge in the highest; do not fear.' },
];

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function nextPermutationState(state: number): number {
  return (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
}

/** Builds a deterministic, user-specific permutation of the full verse pool. */
function getUserVersePermutation(userId: string): number[] {
  const permutation = Array.from({ length: GITA_VERSES.length }, (_, index) => index);
  let state = stableHash(`gita-rotation:${userId}`);

  for (let index = permutation.length - 1; index > 0; index -= 1) {
    state = nextPermutationState(state);
    const swapIndex = state % (index + 1);
    [permutation[index], permutation[swapIndex]] = [permutation[swapIndex], permutation[index]];
  }

  return permutation;
}

/** Selects one verse for a zero-based count of the user's successful sends. */
export function selectGitaVerseForOrdinal(userId: string, sendOrdinal: number): GitaVerse {
  if (!Number.isInteger(sendOrdinal) || sendOrdinal < 0) {
    throw new Error('sendOrdinal must be a non-negative integer');
  }

  const permutation = getUserVersePermutation(userId);
  const index = permutation[positiveModulo(sendOrdinal, GITA_VERSES.length)];
  return GITA_VERSES[index];
}

export const DEFAULT_GITA_VERSE = GITA_VERSES[2];
