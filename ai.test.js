/*
 * ai.test.js
 *
 * Zero-dependency tests for the CPU opponent. Run with:
 *   node ai.test.js
 *
 * Runner, seeded rng, and deck-stacking helpers are shared with
 * engine.test.js via testutil.js. The core guarantee is legality: across
 * thousands of seeded random game states, chooseAction must always
 * return an action the engine accepts.
 */
'use strict';

var E = require('./engine.js');
var AI = require('./ai.js');
var U = require('./testutil.js');

var test = U.test, run = U.run;
var assert = U.assert, assertEqual = U.assertEqual;
var seededRng = U.seededRng, card = U.card;
var makeGame = U.makeGame, trimHand = U.trimHand;
var FILLER0 = U.FILLER[0], FILLER1 = U.FILLER[1];

/* ----- strategy unit tests ----- */

test('prefers the color it holds the most of', function () {
  /* Red 3 and blue 5 are both legal on red 5; the hand is heavy in blue. */
  var hand = [card('red', '3'), card('blue', '5'), card('blue', '9'),
              card('blue', 'skip'), card('green', '1'), card('green', '2'),
              card('yellow', '7')];
  var g = makeGame([hand, FILLER1], card('red', '5'));
  var a = AI.chooseAction(g, 0, seededRng(2));
  assertEqual(a.type, 'play');
  assertEqual(g.players[0].hand[a.cardIndex].color, 'blue');
});

test('holds Wilds while another legal play exists', function () {
  var hand = [card(null, 'wild'), card(null, 'wild4'), card('red', '3'),
              card('green', '1'), card('green', '2'), card('green', '4'),
              card('green', '6')];
  var g = makeGame([hand, FILLER1], card('red', '5'));
  var a = AI.chooseAction(g, 0, seededRng(2));
  assertEqual(a.type, 'play');
  assert(!E.isWild(g.players[0].hand[a.cardIndex]), 'must not spend a Wild yet');
});

test('plays a Wild when nothing else is legal, declaring the majority color', function () {
  var hand = [card(null, 'wild'), card('green', '1'), card('green', '2'),
              card('green', '4'), card('green', '6'), card('blue', '9'),
              card('blue', '7')];
  var g = makeGame([hand, FILLER1], card('red', '5'));
  var a = AI.chooseAction(g, 0, seededRng(2));
  assertEqual(a.type, 'play');
  assertEqual(g.players[0].hand[a.cardIndex].value, 'wild');
  assertEqual(a.chosenColor, 'green', 'green is the hand majority');
});

test('punishes a next opponent at two or fewer cards with a draw card', function () {
  var hand = [card('red', 'draw2'), card('red', '3'), card('red', '4'),
              card('red', '6'), card('red', '7'), card('red', '8'),
              card('red', '9')];
  var g = makeGame([hand, FILLER1], card('red', '5'));
  trimHand(g, 1, 2);
  var a = AI.chooseAction(g, 0, seededRng(2));
  assertEqual(g.players[0].hand[a.cardIndex].value, 'draw2');
});

test('draws when it has no legal play', function () {
  var hand = [card('blue', '9'), card('blue', '7'), card('blue', '1'),
              card('blue', '2'), card('blue', '3'), card('blue', '4'),
              card('blue', '6')];
  var g = makeGame([hand, FILLER0], card('red', '5'));
  var a = AI.chooseAction(g, 0, seededRng(2));
  assertEqual(a.type, 'draw');
});

test('declares Uno unless the injected rng says it forgot', function () {
  var hand = [card('red', '3'), card('red', '4')].concat(FILLER0.slice(0, 5));
  var g = makeGame([hand, FILLER1], card('red', '5'), { cpuForgetUnoChance: 0.5 });
  trimHand(g, 0, 2);
  /* rng below the forget chance means the CPU forgets; at or above, it calls. */
  var forgot = AI.chooseAction(g, 0, function () { return 0.1; });
  assertEqual(forgot.declareUno, false);
  var called = AI.chooseAction(g, 0, function () { return 0.9; });
  assertEqual(called.declareUno, true);
});

test('is deterministic for a given state and seed', function () {
  var g = E.createGame({ numPlayers: 3 }, seededRng(77));
  var a = AI.chooseAction(g, g.currentPlayer, seededRng(5));
  var b = AI.chooseAction(g, g.currentPlayer, seededRng(5));
  assertEqual(JSON.stringify(a), JSON.stringify(b));
});

/* ----- Wild Draw Four challenge decisions ----- */

/*
 * Player 0 plays a Wild Draw Four on a red 5 and declares green, so
 * player 1 is the victim owing a decision. rest0 is what player 0 keeps,
 * which is what the challenge rule judges the play against.
 */
function openWindow(rest0, config) {
  config = config || {};
  config.challengeRule = true;
  var g = makeGame([[card(null, 'wild4')].concat(rest0), FILLER1], card('red', '5'), config);
  return E.applyPlay(g,
    { type: 'play', playerIndex: 0, cardIndex: 0, chosenColor: 'green' }, seededRng(9));
}

test('decideChallenge is deterministic for a given state and seed', function () {
  var g = openWindow(FILLER0.slice(0, 6));
  for (var seed = 1; seed <= 12; seed++) {
    var a = AI.decideChallenge(g, 1, seededRng(seed));
    var b = AI.decideChallenge(g, 1, seededRng(seed));
    assertEqual(a, b, 'seed ' + seed + ' must decide the same way twice');
  }
  /* And it is the injected rng that decides, nothing hidden. */
  assertEqual(AI.decideChallenge(g, 1, function () { return 0; }), true);
  assertEqual(AI.decideChallenge(g, 1, function () { return 0.99; }), false);
});

test('decideChallenge never challenges a legally played last-card Wild Draw Four', function () {
  var g = makeGame([[card(null, 'wild4')].concat(FILLER0.slice(0, 6)), FILLER1],
    card('red', '5'), { challengeRule: true });
  trimHand(g, 0, 1);
  var g2 = E.applyPlay(g,
    { type: 'play', playerIndex: 0, cardIndex: 0, chosenColor: 'green' }, seededRng(9));
  assertEqual(g2.players[0].hand.length, 0, 'the offender is out, pending the decision');
  assertEqual(g2.pendingChallenge.hadColorMatch, false,
    'an emptied hand holds no color, so the play is innocent by construction');
  /*
   * The challenge is therefore a guaranteed loss, paying the total plus
   * two into a round that ends either way. Declining cannot be left to
   * the rng: even a draw that always fires must still decline.
   */
  assertEqual(AI.decideChallenge(g2, 1, function () { return 0; }), false);
  assertEqual(AI.decideChallenge(g2, 1, seededRng(3)), false);
});

test('decideChallenge is safe to call on any state', function () {
  var g = openWindow(FILLER0.slice(0, 6));
  /* Calling for every seat, victim or not, must never throw. */
  for (var i = 0; i < g.config.numPlayers; i++) {
    AI.decideChallenge(g, i, seededRng(i + 1));
  }
  assertEqual(AI.decideChallenge(g, 0, seededRng(1)), false, 'only the victim decides');
  var fresh = makeGame([FILLER0, FILLER1], card('red', '5'), { challengeRule: true });
  assertEqual(AI.decideChallenge(fresh, 0, seededRng(1)), false, 'no window, no challenge');
  assertEqual(AI.decideChallenge(fresh, 1, seededRng(1)), false);
});

test('plays out full games with the challenge rule on, legally at every step', function () {
  for (var seed = 1; seed <= 20; seed++) {
    var rng = seededRng(seed);
    var s = E.createGame({
      numPlayers: 2 + (seed % 3),
      targetScore: 200,
      challengeRule: true,
      stackDraws: seed % 2 === 0
    }, rng);
    var steps = 0;
    while (s.phase !== 'gameOver' && steps < 20000) {
      steps++;
      if (s.phase === 'roundOver') { s = E.startNextRound(s, rng); continue; }
      if (s.pendingChallenge && AI.decideChallenge(s, s.currentPlayer, rng)) {
        s = E.applyChallenge(s, rng);
      } else {
        var action = AI.chooseAction(s, s.currentPlayer, rng);
        if (action.type === 'play') {
          var legal = E.legalPlays(s, s.currentPlayer).some(function (p) {
            return p.cardIndex === action.cardIndex;
          });
          assert(legal, 'seed ' + seed + ' step ' + steps + ': illegal card index');
          s = E.applyPlay(s, action, rng);
        } else {
          assertEqual(action.type, 'draw', 'seed ' + seed + ': unknown action type');
          s = E.applyDraw(s, rng);
        }
      }
      var errors = E.validateState(s);
      assert(errors.length === 0, 'seed ' + seed + ' step ' + steps + ': ' + errors.join('; '));
    }
    assertEqual(s.phase, 'gameOver', 'seed ' + seed + ' must reach game over');
  }
});

/* ----- Wild Draw Four bluffs ----- */

/*
 * Player 0 holds a Wild Draw Four and three red cards on a red 5, so a
 * Wild Draw Four would be a bluff (red is in play) but red plays exist
 * too: a real choice. oppCards sets the next player's hand size: the CPU
 * only bluffs when that is 2 or fewer.
 */
function bluffChoice(chance, oppCards, rule) {
  var hand = [card(null, 'wild4'), card('red', '3'), card('red', '4'), card('red', '6'),
              card('green', '1'), card('green', '2'), card('yellow', '7')];
  var g = makeGame([hand, FILLER1], card('red', '5'),
    { challengeRule: rule !== false, cpuBluffChance: chance });
  trimHand(g, 1, oppCards);
  return g;
}

/* An rng that fails the test if anything draws from it. */
function noRng() { throw new Error('the rng must not be drawn from here'); }

test('bluffs at a low opponent exactly when the injected rng says so', function () {
  var g = bluffChoice(0.5, 2);
  var bluff = AI.chooseAction(g, 0, function () { return 0.1; });
  assertEqual(g.players[0].hand[bluff.cardIndex].value, 'wild4', 'below the chance it bluffs');
  var next = E.applyPlay(g, bluff, seededRng(1));
  assertEqual(next.pendingChallenge.hadColorMatch, true, 'and the engine judges it guilty');
  var honest = AI.chooseAction(g, 0, function () { return 0.9; });
  assertEqual(g.players[0].hand[honest.cardIndex].color, 'red', 'above it the CPU plays red');
});

test('never bluffs in ordinary play, and rolls nothing there', function () {
  /*
   * Bluffing in ordinary play cost the CPU win rate when this was tuned,
   * so it only bluffs at an opponent holding 2 or fewer cards. Even at
   * chance 1, a next player holding 3 or more never sees a chosen bluff.
   */
  [3, 7].forEach(function (oppCards) {
    var g = bluffChoice(1, oppCards);
    var a = AI.chooseAction(g, 0, noRng);
    assertEqual(g.players[0].hand[a.cardIndex].color, 'red', oppCards + ' cards');
  });
});

test('an honest Wild Draw Four at a low opponent is always played and rolls nothing', function () {
  /*
   * No red in hand on a red 5, so the Wild Draw Four is honest. The roll
   * is only for plays that would be a bluff; an honest one goes out as
   * it always did, even at chance 1 and with the rule on.
   */
  var hand = [card(null, 'wild4'), card('yellow', '5'), card('green', '1'), card('green', '2'),
              card('blue', '1'), card('blue', '2'), card('yellow', '7')];
  var g = makeGame([hand, FILLER1], card('red', '5'), { challengeRule: true, cpuBluffChance: 1 });
  trimHand(g, 1, 2);
  var a = AI.chooseAction(g, 0, noRng);
  assertEqual(g.players[0].hand[a.cardIndex].value, 'wild4');
  assert(a.chosenColor !== 'red', 'an honest player holds no red to declare');
});

test('a bluff never re-declares the color already in play', function () {
  /* Red is the hand's longest color, so an honest pick would be red. */
  var g = bluffChoice(1, 2);
  var a = AI.chooseAction(g, 0, function () { return 0; });
  assertEqual(g.players[0].hand[a.cardIndex].value, 'wild4');
  assertEqual(a.chosenColor, 'green', 'the best color other than red');
});

test('cpuBluffChance 0 never bluffs and draws nothing from the rng', function () {
  [2, 7].forEach(function (oppCards) {
    var g = bluffChoice(0, oppCards);
    var a = AI.chooseAction(g, 0, noRng);
    assertEqual(g.players[0].hand[a.cardIndex].color, 'red', oppCards + ' cards');
  });
});

test('with the challenge rule off nothing is a bluff and nothing is rolled', function () {
  /* Even at chance 1: without the challenge a Wild Draw Four is just a card. */
  var low = bluffChoice(1, 2, false);
  var b = AI.chooseAction(low, 0, noRng);
  assertEqual(low.players[0].hand[b.cardIndex].value, 'wild4', 'it punishes a low opponent as before');
  assertEqual(b.chosenColor, 'red', 'declaring its best color, as before');
});

test('a forced Wild Draw Four is not a bluff decision and rolls nothing', function () {
  /*
   * Stacking and the challenge rule: player 1 answers a Wild Draw Four,
   * so a Wild Draw Four is its only legal card. It holds green, the
   * declared color, which on an ordinary turn would make the play a
   * bluff, but an answer is never judged on color, so there is nothing
   * to decide. Player 0 is left with 2 cards, so this is exactly the
   * low-opponent case where bluffs are rolled.
   */
  var hand1 = [card(null, 'wild4'), card('green', '1'), card('green', '2'), card('green', '3'),
               card('blue', '1'), card('blue', '2'), card('blue', '3')];
  var g = makeGame([[card(null, 'wild4')].concat(FILLER0.slice(0, 6)), hand1], card('red', '5'),
    { challengeRule: true, stackDraws: true, cpuBluffChance: 1 });
  trimHand(g, 0, 3);
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0, chosenColor: 'green' }, seededRng(9));
  assertEqual(g2.players[0].hand.length, 2, 'the next player is low');
  assertEqual(E.legalPlays(g2, 1).length, 1, 'only the answering Wild Draw Four is legal');
  var a = AI.chooseAction(g2, 1, noRng);
  assertEqual(g2.players[1].hand[a.cardIndex].value, 'wild4');
  assertEqual(E.applyPlay(g2, a, seededRng(9)).pendingChallenge, null, 'and the answer opens no window');
});

test('at a low opponent a Draw Two outranks any Wild Draw Four, and rolls nothing', function () {
  /* Honest (rule off) or a possible bluff (rule on): the Draw Two goes first. */
  [false, true].forEach(function (rule) {
    var hand = [card(null, 'wild4'), card('red', 'draw2'), card('red', '3'), card('red', '4'),
                card('green', '1'), card('green', '2'), card('yellow', '7')];
    var g = makeGame([hand, FILLER1], card('red', '5'), { challengeRule: rule, cpuBluffChance: 1 });
    trimHand(g, 1, 2);
    var a = AI.chooseAction(g, 0, noRng);
    assertEqual(g.players[0].hand[a.cardIndex].value, 'draw2', 'rule ' + (rule ? 'on' : 'off'));
  });
});

/*
 * Plays seeded all-CPU games and returns every decision as text, with
 * the running count of rng draws, so two runs can be compared exactly.
 */
function decisionTrace(seed, config) {
  var base = seededRng(seed), draws = 0;
  function rng() { draws++; return base(); }
  var s = E.createGame(config, rng), out = [];
  for (var i = 0; i < 20000 && s.phase !== 'gameOver'; i++) {
    if (s.phase === 'roundOver') { s = E.startNextRound(s, rng); continue; }
    var seat = s.currentPlayer;
    if (s.pendingChallenge && AI.decideChallenge(s, seat, rng)) {
      s = E.applyChallenge(s, rng);
      out.push('challenge@' + draws);
      continue;
    }
    var a = AI.chooseAction(s, seat, rng);
    out.push(JSON.stringify(a) + '@' + draws);
    s = a.type === 'draw' ? E.applyDraw(s, rng) : E.applyPlay(s, a, rng);
  }
  return out.join('\n');
}

test('with the challenge rule off, cpuBluffChance changes no decision and no rng draw', function () {
  /* So cpuBluffChance cannot change a game played without the rule. */
  for (var seed = 1; seed <= 15; seed++) {
    var config = { numPlayers: 2 + (seed % 3), targetScore: 200, stackDraws: seed % 2 === 0 };
    var never = decisionTrace(seed, Object.assign({ cpuBluffChance: 0 }, config));
    var always = decisionTrace(seed, Object.assign({ cpuBluffChance: 1 }, config));
    assert(never === always, 'seed ' + seed + ': the game changed');
  }
});

test('across seeded games, chance 1 bluffs at every opportunity and chance 0 at none', function () {
  /*
   * An opportunity is a turn where the CPU could choose to bluff: the
   * next player holds 2 or fewer cards, no Draw Two is legal (it would
   * outrank any Wild Draw Four), a legal Wild Draw Four, the color in
   * play in hand, another legal play, and no just-drawn card to play.
   * Counting them independently of the AI checks that the roll sits
   * exactly where the rule says. Any Wild Draw Four the CPU chooses
   * while holding the color against a next player with 3 or more cards
   * is counted too: that must never happen.
   */
  function count(chance) {
    var t = { chances: 0, bluffs: 0, ordinaryBluffs: 0 };
    for (var seed = 1; seed <= 80; seed++) {
      var rng = seededRng(seed);
      var s = E.createGame({ numPlayers: 2 + (seed % 3), targetScore: 200,
        challengeRule: true, cpuBluffChance: chance }, rng);
      for (var i = 0; i < 20000 && s.phase !== 'gameOver'; i++) {
        if (s.phase === 'roundOver') { s = E.startNextRound(s, rng); continue; }
        var seat = s.currentPlayer;
        if (s.pendingChallenge && AI.decideChallenge(s, seat, rng)) { s = E.applyChallenge(s, rng); continue; }
        var plays = E.legalPlays(s, seat);
        var hasWild4 = plays.some(function (p) { return p.card.value === 'wild4'; });
        var hasOther = plays.some(function (p) { return p.card.value !== 'wild4'; });
        /* A round opened on a flipped Wild has no color in play to hold. */
        var holdsColor = s.currentColor !== null &&
          s.players[seat].hand.some(function (c) { return c.color === s.currentColor; });
        var low = s.players[E.playerAfter(s, seat, 1)].hand.length <= 2;
        var hasDraw2 = plays.some(function (p) { return p.card.value === 'draw2'; });
        var a = AI.chooseAction(s, seat, rng);
        var playedWild4 = a.type === 'play' && s.players[seat].hand[a.cardIndex].value === 'wild4';
        var choice = !s.pendingDraw && hasWild4 && hasOther && holdsColor;
        if (choice && low && !hasDraw2) {
          t.chances++;
          if (playedWild4) t.bluffs++;
        }
        if (choice && !low && playedWild4) t.ordinaryBluffs++;
        s = a.type === 'draw' ? E.applyDraw(s, rng) : E.applyPlay(s, a, rng);
      }
    }
    return t;
  }
  var none = count(0), all = count(1);
  assert(none.chances > 50 && all.chances > 50, 'expected many opportunities, got ' + all.chances);
  assertEqual(none.bluffs, 0, 'chance 0');
  assertEqual(all.bluffs, all.chances, 'chance 1');
  assertEqual(all.ordinaryBluffs, 0, 'chance 1 never bluffs in ordinary play');
});

/* ----- legality soak: thousands of seeded random states ----- */

test('never returns an illegal action across thousands of game states', function () {
  var statesChecked = 0;
  for (var seed = 1; seed <= 60; seed++) {
    var rng = seededRng(seed);
    var s = E.createGame({
      numPlayers: 2 + (seed % 3),
      targetScore: 200,
      stackDraws: seed % 5 === 0
    }, rng);
    var steps = 0;
    while (s.phase !== 'gameOver' && steps < 20000) {
      steps++;
      if (s.phase === 'roundOver') { s = E.startNextRound(s, rng); continue; }
      var action = AI.chooseAction(s, s.currentPlayer, rng);
      statesChecked++;
      if (action.type === 'play') {
        var legal = E.legalPlays(s, s.currentPlayer).some(function (p) {
          return p.cardIndex === action.cardIndex;
        });
        assert(legal, 'seed ' + seed + ' step ' + steps + ': illegal card index');
        /* applyPlay re-validates everything, including the Wild color. */
        s = E.applyPlay(s, action, rng);
      } else {
        assertEqual(action.type, 'draw', 'seed ' + seed + ': unknown action type');
        s = E.applyDraw(s, rng);
      }
      var errors = E.validateState(s);
      assert(errors.length === 0, 'seed ' + seed + ' step ' + steps + ': ' + errors.join('; '));
    }
    assertEqual(s.phase, 'gameOver', 'seed ' + seed + ' must reach game over');
  }
  assert(statesChecked > 5000, 'expected thousands of states, got ' + statesChecked);
  console.log('      (' + statesChecked + ' states checked)');
});

/* ----- run ----- */

run();
