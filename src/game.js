const crypto = require('node:crypto');

const BUILTIN_GAME = {
  rounds: [
    {
      question: 'Name something people realize they forgot just after leaving home.',
      answers: [
        { text: 'KEYS', points: 31, aliases: ['key', 'car keys', 'house keys', 'my keys'] },
        { text: 'PHONE', points: 24, aliases: ['cell phone', 'cellphone', 'mobile', 'mobile phone'] },
        { text: 'WALLET / PURSE', points: 17, aliases: ['wallet', 'purse', 'money', 'credit cards'] },
        { text: 'LUNCH / FOOD', points: 10, aliases: ['lunch', 'food', 'snack', 'meal'] },
        { text: 'GLASSES', points: 8, aliases: ['glasses', 'eyeglasses', 'sunglasses'] },
        { text: 'WORK / SCHOOL ITEM', points: 6, aliases: ['homework', 'briefcase', 'computer', 'laptop', 'school bag'] },
        { text: 'UMBRELLA / COAT', points: 4, aliases: ['umbrella', 'coat', 'jacket'] }
      ]
    },
    {
      question: 'Name something families often argue about on a road trip.',
      answers: [
        { text: 'DIRECTIONS / ROUTE', points: 32, aliases: ['directions', 'route', 'map', 'getting lost', 'where to go'] },
        { text: 'MUSIC / RADIO', points: 23, aliases: ['music', 'radio', 'song', 'playlist'] },
        { text: 'WHERE TO STOP', points: 17, aliases: ['stops', 'where to stop', 'bathroom break', 'rest stop', 'food stop'] },
        { text: 'TEMPERATURE', points: 12, aliases: ['temperature', 'air conditioning', 'heat', 'too hot', 'too cold'] },
        { text: 'SEATING / SPACE', points: 9, aliases: ['seat', 'seating', 'space', 'who sits where'] },
        { text: 'DRIVING', points: 7, aliases: ['driving', 'speed', 'bad driver', 'how fast'] }
      ]
    },
    {
      question: 'Name something people do while waiting for a kettle to boil.',
      answers: [
        { text: 'CHECK THEIR PHONE', points: 36, aliases: ['phone', 'check phone', 'text', 'social media'] },
        { text: 'GET CUP / TEA READY', points: 26, aliases: ['get a cup', 'prepare tea', 'tea bag', 'mug', 'coffee'] },
        { text: 'CLEAN / TIDY', points: 17, aliases: ['clean', 'tidy', 'wash dishes', 'wipe counter'] },
        { text: 'MAKE FOOD', points: 12, aliases: ['food', 'toast', 'snack', 'prepare food'] },
        { text: 'WATCH THE KETTLE', points: 9, aliases: ['wait', 'watch it', 'stand there', 'stare'] }
      ]
    },
    {
      question: 'Name something a person might keep beside the bed.',
      answers: [
        { text: 'PHONE', points: 41, aliases: ['phone', 'cell phone', 'cellphone', 'mobile'] },
        { text: 'LAMP', points: 27, aliases: ['lamp', 'light', 'bedside light'] },
        { text: 'WATER', points: 19, aliases: ['water', 'drink', 'glass of water', 'water bottle'] },
        { text: 'CLOCK', points: 13, aliases: ['clock', 'alarm', 'alarm clock'] }
      ]
    }
  ],
  fastMoney: [
    { question: 'Name a food people eat with their hands.', answers: [{ text: 'PIZZA', points: 34, aliases: ['pizza'] }, { text: 'BURGER', points: 26, aliases: ['burger', 'hamburger'] }, { text: 'SANDWICH', points: 18, aliases: ['sandwich'] }, { text: 'FRIES', points: 13, aliases: ['fries', 'french fries'] }, { text: 'CHICKEN', points: 9, aliases: ['chicken', 'wings'] }] },
    { question: 'Name something you do before going to sleep.', answers: [{ text: 'BRUSH TEETH', points: 35, aliases: ['brush teeth', 'teeth'] }, { text: 'CHANGE CLOTHES', points: 23, aliases: ['pajamas', 'change clothes', 'get dressed'] }, { text: 'CHECK PHONE', points: 19, aliases: ['phone', 'check phone'] }, { text: 'READ', points: 14, aliases: ['read', 'book'] }, { text: 'WASH', points: 9, aliases: ['wash', 'shower', 'wash face'] }] },
    { question: 'Name a reason someone might be late.', answers: [{ text: 'TRAFFIC', points: 38, aliases: ['traffic', 'traffic jam'] }, { text: 'OVERSLEPT', points: 27, aliases: ['overslept', 'slept in'] }, { text: 'MISSED BUS / TRAIN', points: 15, aliases: ['bus', 'train', 'missed bus', 'transit'] }, { text: 'CHILDREN', points: 11, aliases: ['kids', 'children', 'baby'] }, { text: 'LOST SOMETHING', points: 9, aliases: ['lost keys', 'lost something', 'could not find'] }] },
    { question: 'Name something people put on toast.', answers: [{ text: 'BUTTER', points: 39, aliases: ['butter'] }, { text: 'JAM', points: 29, aliases: ['jam', 'jelly'] }, { text: 'PEANUT BUTTER', points: 17, aliases: ['peanut butter'] }, { text: 'EGGS', points: 9, aliases: ['egg', 'eggs'] }, { text: 'CHEESE', points: 6, aliases: ['cheese'] }] },
    { question: 'Name something you might find in a garage.', answers: [{ text: 'CAR', points: 42, aliases: ['car', 'vehicle'] }, { text: 'TOOLS', points: 25, aliases: ['tools', 'tool'] }, { text: 'BICYCLE', points: 14, aliases: ['bike', 'bicycle'] }, { text: 'LAWN MOWER', points: 11, aliases: ['mower', 'lawn mower'] }, { text: 'BOXES', points: 8, aliases: ['boxes', 'storage'] }] }
  ]
};

function normalize(value = '') {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').replace(/\b(my|a|an|the|some|their|his|her)\b/g, ' ')
    .replace(/\b(phones|keys|glasses|eggs|fries|tools|boxes|children)\b/g, m => ({ phones: 'phone', keys: 'key', glasses: 'glass', eggs: 'egg', fries: 'fry', tools: 'tool', boxes: 'box', children: 'child' }[m]))
    .replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp;
    }
  }
  return row[b.length];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if ((a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 4) return .94;
  const aw = new Set(a.split(' ')); const bw = new Set(b.split(' '));
  const intersection = [...aw].filter(x => bw.has(x)).length;
  const jaccard = intersection / new Set([...aw, ...bw]).size;
  const edit = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  return Math.max(jaccard, edit);
}

function matchAnswer(guess, answers, revealed = []) {
  const n = normalize(guess);
  let best = { index: -1, confidence: 0 };
  answers.forEach((answer, index) => {
    if (revealed.includes(index)) return;
    const variants = [answer.text, ...(answer.aliases || [])].map(normalize);
    const confidence = Math.max(...variants.map(v => similarity(n, v)));
    if (confidence > best.confidence) best = { index, confidence };
  });
  if (best.confidence < (n.length <= 4 ? .9 : .76)) return { index: -1, confidence: best.confidence };
  return best;
}

function validatePackage(game) {
  if (!game || !Array.isArray(game.rounds) || !Array.isArray(game.fastMoney)) return false;
  if (game.rounds.length !== 4 || game.fastMoney.length !== 5) return false;
  const expected = [7, 6, 5, 4];
  return game.rounds.every((r, i) => r.question && r.answers?.length === expected[i] && r.answers.every(validAnswer) && total(r.answers) === 100 && descending(r.answers))
    && game.fastMoney.every(q => q.question && q.answers?.length >= 4 && q.answers.every(validAnswer) && total(q.answers) === 100 && descending(q.answers));
}

function validAnswer(a) { return typeof a.text === 'string' && Number.isInteger(a.points) && a.points > 0 && Array.isArray(a.aliases); }
function total(answers) { return answers.reduce((sum, answer) => sum + answer.points, 0); }
function descending(answers) { return answers.every((answer, i) => i === 0 || answers[i - 1].points > answer.points); }

async function judgeAnswer(guess, answers, revealed = []) {
  const local = matchAnswer(guess, answers, revealed);
  if (local.index >= 0 || !process.env.OPENAI_API_KEY || local.confidence < .42) return local;
  try {
    const candidates = answers.map((a, index) => ({ index, answer: a.text, aliases: a.aliases })).filter(x => !revealed.includes(x.index));
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_JUDGE_MODEL || 'gpt-5-nano',
        instructions: 'Judge a Family Feud guess conservatively. Match only when an ordinary host would clearly treat the guess as the same concept as one candidate. Examples and narrower forms may match a broader category. Related-but-distinct concepts do not match. Return -1 when uncertain.',
        input: JSON.stringify({ guess, candidates }),
        text: { format: { type: 'json_schema', name: 'answer_judgment', strict: true, schema: { type: 'object', additionalProperties: false, properties: { index: { type: 'integer', minimum: -1 }, reason: { type: 'string' } }, required: ['index', 'reason'] } } }
      })
    });
    if (!response.ok) return local;
    const payload = await response.json();
    const output = payload.output_text || payload.output?.flatMap(x => x.content || []).find(x => x.type === 'output_text')?.text;
    const judged = JSON.parse(output);
    return candidates.some(x => x.index === judged.index) ? { index: judged.index, confidence: .7, ai: true } : local;
  } catch { return local; }
}

const GENERATOR_INSTRUCTIONS = `You create Family Feud survey boards for a private family game. Return JSON only, matching the supplied schema.

QUALITY AND FAIRNESS
- Questions must feel like authentic, broadly answerable survey prompts: concrete, playful, family-safe, and based on ordinary experience.
- Do not use trivia, factual questions, specialist knowledge, brand advertising, politics, religion, sex, health diagnoses, stereotypes, protected traits, cruelty, or humiliating material.
- Every main-board answer must be clearly distinct. Never split near-synonyms into separate slots.
- Prefer answers that players can express in many natural ways. Give every answer 4-10 useful aliases, including common Canadian and American variants where relevant.
- Points must be plausible counts from 100 surveyed people, descending strictly, and sum to exactly 100 for each board.
- Write board labels in concise uppercase display language. Write questions in natural sentence case.

MAIN GAME
- Exactly four rounds.
- Round 1: exactly 7 answers; round 2: 6; round 3: 5; round 4: 4.
- Later questions should have broader top answers and fewer plausible categories.
- Do not repeat a topic or dominant answer across the four rounds.

FAST MONEY
- Exactly five separate, shorter questions.
- Each needs at least 5 distinct ranked answers whose points sum to 100.
- Questions must be quick to understand and answer in a few words.
- Avoid overlap with the four main-game topics.

ALIASES
- Aliases are accepted paraphrases of the same concept, never examples that properly belong under a different board answer.
- Include singular/plural, everyday wording, and obvious compound forms, but do not make aliases so broad that an incorrect answer would match.

Before returning JSON, silently verify exact answer counts, descending positive integer points, 100-point totals, unique concepts, and non-overlapping aliases.`;

async function generateGamePackage() {
  if (!process.env.OPENAI_API_KEY) return structuredClone(BUILTIN_GAME);
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      rounds: { type: 'array', minItems: 4, maxItems: 4, items: boardSchema() },
      fastMoney: { type: 'array', minItems: 5, maxItems: 5, items: boardSchema() }
    }, required: ['rounds', 'fastMoney']
  };
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-5-mini',
        instructions: GENERATOR_INSTRUCTIONS,
        input: 'Create one new complete game package. Use the exact requested answer counts and ensure every board totals 100.',
        text: { format: { type: 'json_schema', name: 'family_feud_game', strict: true, schema } }
      })
    });
    if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
    const payload = await response.json();
    const output = payload.output_text || payload.output?.flatMap(x => x.content || []).find(x => x.type === 'output_text')?.text;
    const game = JSON.parse(output);
    if (!validatePackage(game)) throw new Error('Generated package failed validation');
    return game;
  } catch (error) {
    console.error('Using built-in boards:', error.message);
    return structuredClone(BUILTIN_GAME);
  }
}

function boardSchema() {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      question: { type: 'string' },
      answers: {
        type: 'array', minItems: 4, maxItems: 7,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            text: { type: 'string' },
            points: { type: 'integer', minimum: 1, maximum: 100 },
            aliases: { type: 'array', minItems: 2, maxItems: 12, items: { type: 'string' } }
          },
          required: ['text', 'points', 'aliases']
        }
      }
    },
    required: ['question', 'answers']
  };
}

function newCode() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }

module.exports = { BUILTIN_GAME, GENERATOR_INSTRUCTIONS, generateGamePackage, judgeAnswer, matchAnswer, normalize, validatePackage, newCode };
