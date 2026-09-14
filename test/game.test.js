const test = require('node:test');
const assert = require('node:assert/strict');
const { matchAnswer, judgeAnswer, validatePackage, BUILTIN_GAME } = require('../src/game');

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
  assert.equal(matchAnswer('buttons', [{ text: 'BUTTON', points: 20, aliases: [] }]).index, 0);
  assert.equal(matchAnswer('a button', [{ text: 'BUTTONS', points: 20, aliases: [] }]).index, 0);
});

test('answer matcher rejects unrelated guesses', () => {
  assert.equal(matchAnswer('a purple elephant', BUILTIN_GAME.rounds[0].answers).index, -1);
});

test('AI judge requests specificity when a broad guess could match multiple answers', async t => {
  const originalKey=process.env.OPENAI_API_KEY,originalFetch=global.fetch;
  process.env.OPENAI_API_KEY='test-key';
  global.fetch=async()=>({ok:true,json:async()=>({output_text:JSON.stringify({index:-1,accepted:false,clarify:true,reason:'The guess could mean either animal.'})})});
  t.after(()=>{if(originalKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=originalKey;global.fetch=originalFetch;});
  const result=await judgeAnswer('another animal',[{text:'DOG',aliases:['dog']},{text:'ANOTHER CAT',aliases:['another cat']}]);
  assert.equal(result.index,-1);assert.equal(result.clarify,true);
});
