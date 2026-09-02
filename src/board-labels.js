// Keep display wording compact without discarding the concepts the judge accepts.
// Explicit rewrites avoid truncating words or choosing a narrower alias at random.
const SHORT_LABELS = {
  'WORK / SCHOOL ITEM': 'WORK GEAR',
  'GET CUP / TEA READY': 'PREPARE TEA',
  'CHECK THEIR PHONE': 'CHECK PHONE',
  'A DOG STEALING FOOD': 'DOG STEALS FOOD',
  'A NEIGHBOUR COMPLAINING': 'NOISE COMPLAINT',
  'AN ITEM UNDER THE CART': 'UNDER-CART ITEM',
  'ARGUMENT WITH PARTNER': 'ARGUMENT',
  'ASK A NEIGHBOUR FOR HELP': 'ASK A NEIGHBOUR',
  'CAKE ARRIVES AT WRONG TIME': 'CAKE TIMING',
  'CALL A FAMILY MEMBER': 'CALL FAMILY',
  'CALL THE FIRE DEPARTMENT': 'CALL FIRE DEPT.',
  'CALL THE POWER COMPANY': 'CALL POWER CO.',
  'CAMERA SHOWS PYJAMAS': 'PYJAMAS ON CAMERA',
  'CHANGE A LIGHT BULB': 'CHANGE BULB',
  'CLIMB THROUGH A WINDOW': 'USE A WINDOW',
  'COMFORTABLE FURNITURE': 'COMFY FURNITURE',
  'DOES NOT WANT TO MISS OUT': 'MISSING OUT',
  'DRINK SOMETHING COLD': 'COLD DRINK',
  'EXPLAIN THE NEIGHBOURHOOD': 'LOCAL ADVICE',
  'FELL ASLEEP WATCHING TV': 'DOZED OFF AT TV',
  'FINGERPRINT SCANNER': 'FINGERPRINT ID',
  'FORGOT THEY WERE ON CAMERA': 'FORGOT CAMERA',
  'GAME CONTROLLER BUTTON': 'CONTROLLER BUTTON',
  'GUEST ARRIVES EARLY': 'EARLY GUEST',
  'GUEST DOES NOT SHOW UP': 'NO-SHOW GUEST',
  'GUEST USING THE BED': 'GUEST IN BED',
  'INTRODUCE THEMSELVES': 'SAY HELLO',
  'LATE INCOMING PLANE': 'LATE PLANE',
  'LISTEN TO AN AUDIOBOOK': 'AUDIOBOOK',
  'LOOK FOR ANOTHER ROUTE': 'FIND A NEW ROUTE',
  'LOOK FOR THE SOURCE': 'FIND THE SOURCE',
  'LOOK UNDER FURNITURE': 'UNDER FURNITURE',
  'LOWER COST OF LIVING': 'LOWER COSTS',
  'NEED TO GET WORK DONE': 'WORK TO DO',
  'NEWSPAPER CLIPPINGS': 'NEWS CLIPPINGS',
  'NOTHING YOU LIKE ON THE MENU': 'DISLIKE MENU',
  'PARTNER CANNOT COME': 'PARTNER ABSENT',
  'PET TOOK OVER THE BED': 'PET IN BED',
  'PUT IT IN AN ENVELOPE': 'USE AN ENVELOPE',
  'PUT PRICES ON ITEMS': 'PRICE ITEMS',
  'RETRACE THEIR STEPS': 'RETRACE STEPS',
  'SOMEONE KNOCKING IT OVER': 'KNOCKED OVER',
  'SOMEONE NEEDS YOUR SEAT': 'GIVE UP SEAT',
  'SOMEONE TOUCHING IT': 'TOUCHING IT',
  'SOMETHING STUCK IN A WHEEL': 'JAMMED WHEEL',
  'SOUND EQUIPMENT FAILURE': 'SOUND FAILURE',
  'STOP AT ATTRACTIONS': 'SIGHTSEEING',
  'STYLE IT DIFFERENTLY': 'RESTYLE IT',
  'UNCOMFORTABLE SEATS': 'UNCOMFY SEATS',
  'VISIT LASTED TOO LONG': 'LONG VISIT',
  'VISITOR WAS CRITICAL': 'CRITICAL VISITOR',
  'WAIT FOR SOMEONE TO COME HOME': 'WAIT FOR HELP',
  'WANTS ANOTHER STORY': 'ANOTHER STORY',
  'WANTS TO KEEP PLAYING': 'KEEP PLAYING',
  'WHEN THEY WILL RETURN': 'RETURN TIME',
  'WRONG GROUP MESSAGE': 'WRONG GROUP CHAT',
  'WRONG SCREEN SHARED': 'WRONG SCREEN'
};

function compactBoardLabels(game) {
  for (const board of [...game.rounds, game.suddenDeath, ...game.fastMoney]) {
    for (const answer of board.answers) {
      const original = answer.text.trim();
      const alternatives = original.split(/\s*\/\s*/).filter(Boolean);
      const primary = alternatives[0] || original;
      answer.text = SHORT_LABELS[original.toUpperCase()] || SHORT_LABELS[primary.toUpperCase()] || primary.toUpperCase();
      const aliases = [...answer.aliases];
      if (answer.text !== original) aliases.push(original, ...alternatives);
      // The snowman category includes heat, even when the board simply says SUN.
      if (answer.text === 'SUN' && /snowm[ae]n/i.test(board.question)) {
        aliases.push('gets too warm', 'too warm', 'heat', 'hot weather', 'warm weather', 'sun melts it');
      }
      answer.aliases = [...new Set(aliases)];
    }
  }
  return game;
}

function hasCompactBoardLabels(game) {
  return [...game.rounds, game.suddenDeath, ...game.fastMoney].every(board =>
    board.answers.every(answer => answer.text.length > 0 && answer.text.length <= 18));
}

module.exports = { compactBoardLabels, hasCompactBoardLabels };
