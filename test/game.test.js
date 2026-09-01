const test = require('node:test');
const assert = require('node:assert/strict');
const { matchAnswer, validatePackage, BUILTIN_GAME } = require('../src/game');

test('built-in game has the required shape', () => {
  assert.equal(validatePackage(BUILTIN_GAME), true);
  assert.equal(BUILTIN_GAME.suddenDeath.answers.length, 1);
});

test('a generated package without one-answer Sudden Death is rejected', () => {
  const invalid = structuredClone(BUILTIN_GAME);
  invalid.suddenDeath.answers.push({ text: 'GET OUT OF BED', points: 25, aliases: ['stand up', 'get up'] });
  assert.equal(validatePackage(invalid), false);
});

test('answer matcher accepts aliases and close plurals', () => {
  const answers = BUILTIN_GAME.rounds[0].answers;
  assert.equal(matchAnswer('my keys', answers).index, 0);
  assert.equal(matchAnswer('cellphone', answers).index, 1);
});

test('answer matcher rejects unrelated guesses', () => {
  assert.equal(matchAnswer('a purple elephant', BUILTIN_GAME.rounds[0].answers).index, -1);
});
