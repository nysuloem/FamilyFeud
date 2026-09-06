const { randomInt } = require('node:crypto');
const ERAS = Object.freeze({
  dawson: Object.freeze({ name: 'Richard Dawson', period: '1970s', voice: 'onyx', fastMoneyJackpot: 10000 }),
  harvey: Object.freeze({ name: 'Steve Harvey', period: 'modern', voice: 'echo', fastMoneyJackpot: 20000 })
});
function chooseEra(draw = randomInt) { return draw(2) === 0 ? 'dawson' : 'harvey'; }
module.exports = { ERAS, chooseEra };
