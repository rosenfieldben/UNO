/*
 * engine.test.js
 *
 * Zero-dependency test suite for the Uno engine. Run with:
 *   node engine.test.js
 *
 * All randomness comes from a seeded rng (mulberry32) so every run is
 * identical. Where a test needs exact cards in exact places it uses the
 * engine's presetDeck hook (config._deck) or moves cards between zones
 * of a real game state, which keeps the 108-card conservation invariant
 * intact so validateState stays meaningful.
 */
'use strict';

var E = require('./engine.js');

/* ----- tiny test runner ----- */

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'assertEqual') + ': expected ' + JSON.stringify(expected) +
      ', got ' + JSON.stringify(actual));
  }
}
function assertThrows(fn, msg) {
  var threw = false;
  try { fn(); } catch (e) { threw = true; }
  if (!threw) throw new Error(msg || 'expected an exception');
}
function assertValid(state, msg) {
  var errors = E.validateState(state);
  if (errors.length) {
    throw new Error((msg || 'state invalid') + ': ' + errors.join('; '));
  }
}

/* ----- deterministic rng (mulberry32) ----- */

function seededRng(seed) {
  var t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    var r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/* ----- helpers ----- */

function card(color, value) { return { color: color, value: value }; }

function sameCard(a, b) { return a.color === b.color && a.value === b.value; }

/*
 * Builds a full 108-card deck where the cards in topCards are drawn
 * first, in order (cards are drawn with pop(), so the first requested
 * card sits at the end of the array).
 */
function stackDeck(topCards) {
  var deck = E.buildDeck();
  var picked = topCards.map(function (spec) {
    var i = -1;
    for (var k = 0; k < deck.length; k++) {
      if (sameCard(deck[k], spec)) { i = k; break; }
    }
    if (i === -1) throw new Error('stackDeck: no such card left: ' + spec.color + ' ' + spec.value);
    return deck.splice(i, 1)[0];
  });
  return deck.concat(picked.reverse());
}

/*
 * With numPlayers players, dealing interleaves seats: pops 0..7n-1 go to
 * seats 0,1,..,n-1 repeating, and pop 7n is the first flip. This builds
 * the topCards list for stackDeck from per-seat hands plus a flip card.
 */
function dealOrder(hands, flip) {
  var order = [];
  for (var c = 0; c < 7; c++) {
    for (var p = 0; p < hands.length; p++) order.push(hands[p][c]);
  }
  order.push(flip);
  return order;
}

function makeGame(hands, flip, config) {
  config = config || {};
  config.numPlayers = hands.length;
  config._deck = stackDeck(dealOrder(hands, flip));
  return E.createGame(config, seededRng(config.seed || 1));
}

/* Seven filler cards per seat that never interact with a red-number top. */
var FILLER = {
  0: [card('green', '1'), card('green', '2'), card('green', '3'), card('green', '4'),
      card('green', '6'), card('green', '7'), card('green', '8')],
  1: [card('blue', '1'), card('blue', '2'), card('blue', '3'), card('blue', '4'),
      card('blue', '6'), card('blue', '7'), card('blue', '8')],
  2: [card('yellow', '1'), card('yellow', '2'), card('yellow', '3'), card('yellow', '4'),
      card('yellow', '6'), card('yellow', '7'), card('yellow', '8')]
};

/* Moves the first drawPile card matching spec into the given hand, keeping
 * conservation intact. Used to shrink or shape hands mid-test. */
function moveToHand(state, playerIndex, spec) {
  for (var i = 0; i < state.drawPile.length; i++) {
    if (sameCard(state.drawPile[i], spec)) {
      state.players[playerIndex].hand.push(state.drawPile.splice(i, 1)[0]);
      return;
    }
  }
  throw new Error('moveToHand: card not in draw pile');
}

/* Moves all but the first `keep` cards of a hand to the bottom of the
 * draw pile (bottom = index 0, since draws pop from the end). */
function trimHand(state, playerIndex, keep) {
  var hand = state.players[playerIndex].hand;
  var removed = hand.splice(keep);
  state.drawPile = removed.concat(state.drawPile);
}

/* ----- deck composition ----- */

test('deck has exactly 108 cards with the right composition', function () {
  var deck = E.buildDeck();
  assertEqual(deck.length, 108, 'deck size');
  var counts = {};
  deck.forEach(function (c) {
    var k = (c.color || 'wild') + ':' + c.value;
    counts[k] = (counts[k] || 0) + 1;
  });
  E.COLORS.forEach(function (color) {
    assertEqual(counts[color + ':0'], 1, color + ' zeros');
    for (var n = 1; n <= 9; n++) {
      assertEqual(counts[color + ':' + n], 2, color + ' ' + n + 's');
    }
    assertEqual(counts[color + ':skip'], 2, color + ' skips');
    assertEqual(counts[color + ':reverse'], 2, color + ' reverses');
    assertEqual(counts[color + ':draw2'], 2, color + ' draw twos');
  });
  assertEqual(counts['wild:wild'], 4, 'wilds');
  assertEqual(counts['wild:wild4'], 4, 'wild draw fours');
});

test('card point values follow standard scoring', function () {
  assertEqual(E.cardPoints(card('red', '0')), 0);
  assertEqual(E.cardPoints(card('red', '7')), 7);
  assertEqual(E.cardPoints(card('blue', 'skip')), 20);
  assertEqual(E.cardPoints(card('blue', 'reverse')), 20);
  assertEqual(E.cardPoints(card('blue', 'draw2')), 20);
  assertEqual(E.cardPoints(card(null, 'wild')), 50);
  assertEqual(E.cardPoints(card(null, 'wild4')), 50);
  assertEqual(E.handPoints([card('red', '9'), card(null, 'wild'), card('green', 'skip')]), 79);
});

/* ----- dealing and first flip ----- */

test('createGame deals 7 cards each and flips one card', function () {
  var g = E.createGame({ numPlayers: 3 }, seededRng(42));
  g.players.forEach(function (p) { assertEqual(p.hand.length, 7); });
  assertEqual(g.discardPile.length, 1);
  assertEqual(g.drawPile.length, 108 - 21 - 1);
  assertEqual(g.currentPlayer, 0);
  assertValid(g);
  assert(E.topDiscard(g).value !== 'wild4', 'first flip must never be a Wild Draw Four');
});

test('preset deck deals in seat order with the flip after the deal', function () {
  var g = makeGame([FILLER[0], FILLER[1]], card('red', '5'));
  assert(sameCard(g.players[0].hand[0], card('green', '1')));
  assert(sameCard(g.players[1].hand[0], card('blue', '1')));
  assert(sameCard(E.topDiscard(g), card('red', '5')));
  assertEqual(g.currentColor, 'red');
  assertValid(g);
});

test('first flip Wild Draw Four is returned and reshuffled away', function () {
  var g = makeGame([FILLER[0], FILLER[1]], card(null, 'wild4'));
  assert(E.topDiscard(g).value !== 'wild4', 'wild4 must not start the discard');
  assertEqual(g.discardPile.length, 1);
  g.players.forEach(function (p) { assertEqual(p.hand.length, 7); });
  assertValid(g, 'all 108 cards must survive the reshuffle');
});

test('first flip is never wild4 across many seeded games', function () {
  for (var seed = 1; seed <= 200; seed++) {
    var g = E.createGame({ numPlayers: 4 }, seededRng(seed));
    assert(E.topDiscard(g).value !== 'wild4', 'seed ' + seed);
    assertValid(g, 'seed ' + seed);
  }
});

test('first flip Skip makes player 0 lose the opening turn', function () {
  var g = makeGame([FILLER[0], FILLER[1], FILLER[2]], card('red', 'skip'));
  assertEqual(g.currentPlayer, 1);
});

test('first flip Draw Two makes player 0 draw two and lose the turn', function () {
  var g = makeGame([FILLER[0], FILLER[1]], card('red', 'draw2'));
  assertEqual(g.players[0].hand.length, 9);
  assertEqual(g.currentPlayer, 1);
  assertValid(g);
});

test('first flip Reverse reverses direction with 3 players', function () {
  var g = makeGame([FILLER[0], FILLER[1], FILLER[2]], card('red', 'reverse'));
  assertEqual(g.direction, -1);
  assertEqual(g.currentPlayer, 0, 'player 0 still leads');
});

test('first flip Reverse acts as Skip with 2 players', function () {
  var g = makeGame([FILLER[0], FILLER[1]], card('red', 'reverse'));
  assertEqual(g.currentPlayer, 1, 'player 0 is skipped');
});

test('first flip Wild lets player 0 play anything', function () {
  var g = makeGame([FILLER[0], FILLER[1]], card(null, 'wild'));
  assertEqual(g.currentColor, null);
  assertEqual(E.legalPlays(g, 0).length, 7, 'every card matches a null color');
});

/* ----- legality ----- */

test('legalPlays matches by color, by value, and wilds', function () {
  var hand = [card('red', '3'), card('blue', '5'), card('blue', '9'),
              card('green', 'skip'), card(null, 'wild'), card(null, 'wild4'),
              card('yellow', '7')];
  var g = makeGame([hand, FILLER[1]], card('red', '5'));
  var idx = E.legalPlays(g, 0).map(function (p) { return p.cardIndex; });
  assertEqual(JSON.stringify(idx), JSON.stringify([0, 1, 4, 5]),
    'red 3 (color), blue 5 (value), wild, wild4');
});

test('legalPlays is empty for the non-current player', function () {
  var g = makeGame([FILLER[0], FILLER[1]], card('red', '5'));
  assertEqual(E.legalPlays(g, 1).length, 0);
});

test('applyPlay rejects illegal moves and leaves state untouched', function () {
  var hand = [card('blue', '9'), card('green', '1'), card('green', '2'),
              card('green', '3'), card('green', '4'), card('green', '6'),
              card('green', '7')];
  var g = makeGame([hand, FILLER[1]], card('red', '5'));
  var snapshot = JSON.stringify(g);
  assertThrows(function () {
    E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  }, 'blue 9 on red 5 must be rejected');
  assertThrows(function () {
    E.applyPlay(g, { type: 'play', playerIndex: 1, cardIndex: 0 }, seededRng(9));
  }, 'acting out of turn must be rejected');
  assertThrows(function () {
    E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 99 }, seededRng(9));
  }, 'out of range card index must be rejected');
  assertEqual(JSON.stringify(g), snapshot, 'rejected plays must not mutate state');
});

test('a Wild without a declared color is rejected', function () {
  var hand = FILLER[0].slice(0, 6).concat([card(null, 'wild')]);
  var g = makeGame([hand, FILLER[1]], card('red', '5'));
  assertThrows(function () {
    E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 6 }, seededRng(9));
  });
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 6, chosenColor: 'blue' }, seededRng(9));
  assertEqual(g2.currentColor, 'blue');
  assertValid(g2);
});

/* ----- action card effects ----- */

test('Skip skips the next player', function () {
  var hand = [card('red', 'skip')].concat(FILLER[0].slice(0, 6));
  var g = makeGame([hand, FILLER[1], FILLER[2]], card('red', '5'));
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  assertEqual(g2.currentPlayer, 2);
});

test('Reverse reverses direction with 3+ players', function () {
  var hand = [card('red', 'reverse')].concat(FILLER[0].slice(0, 6));
  var g = makeGame([hand, FILLER[1], FILLER[2]], card('red', '5'));
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  assertEqual(g2.direction, -1);
  assertEqual(g2.currentPlayer, 2, 'play proceeds to the seat behind');
});

test('Reverse acts as Skip in a 2-player game', function () {
  var hand = [card('red', 'reverse')].concat(FILLER[0].slice(0, 6));
  var g = makeGame([hand, FILLER[1]], card('red', '5'));
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  assertEqual(g2.currentPlayer, 0, 'the same player goes again');
  assertValid(g2);
});

test('Draw Two makes the next player draw two and lose their turn', function () {
  var hand = [card('red', 'draw2')].concat(FILLER[0].slice(0, 6));
  var g = makeGame([hand, FILLER[1], FILLER[2]], card('red', '5'));
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  assertEqual(g2.players[1].hand.length, 9);
  assertEqual(g2.currentPlayer, 2);
  assertValid(g2);
});

test('Wild Draw Four forces four and loses the turn', function () {
  var hand = [card(null, 'wild4')].concat(FILLER[0].slice(0, 6));
  var g = makeGame([hand, FILLER[1], FILLER[2]], card('red', '5'));
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0, chosenColor: 'green' }, seededRng(9));
  assertEqual(g2.players[1].hand.length, 11);
  assertEqual(g2.currentPlayer, 2);
  assertEqual(g2.currentColor, 'green');
  assertValid(g2);
});

/* ----- drawing ----- */

test('drawing an unplayable card passes the turn', function () {
  var hand = [card('blue', '9')].concat(FILLER[0].slice(0, 6));
  var g = makeGame([hand, FILLER[1]], card('red', '5'));
  trimHand(g, 0, 1);
  /* Put a card that cannot land on red 5 on top of the draw pile. */
  moveToHand(g, 0, card('green', '9'));
  g.drawPile.push(g.players[0].hand.pop());
  var g2 = E.applyDraw(g, seededRng(9));
  assertEqual(g2.players[0].hand.length, 2);
  assertEqual(g2.pendingDraw, null);
  assertEqual(g2.currentPlayer, 1, 'green 9 on red 5: turn passes');
  assertValid(g2);
});

test('a drawn playable card may be played immediately or kept', function () {
  var hand = [card('blue', '9')].concat(FILLER[0].slice(0, 6));
  var g = makeGame([hand, FILLER[1]], card('red', '5'));
  trimHand(g, 0, 1);
  moveToHand(g, 0, card('red', '7'));
  g.drawPile.push(g.players[0].hand.pop());
  var g2 = E.applyDraw(g, seededRng(9));
  assertEqual(g2.currentPlayer, 0, 'turn does not pass yet');
  assert(g2.pendingDraw, 'drawn card is pending');
  var plays = E.legalPlays(g2, 0);
  assertEqual(plays.length, 1, 'only the drawn card is playable');
  assert(sameCard(plays[0].card, card('red', '7')));
  assertThrows(function () { E.applyDraw(g2, seededRng(9)); }, 'cannot draw twice');

  var played = E.applyPlay(g2, { type: 'play', playerIndex: 0, cardIndex: plays[0].cardIndex }, seededRng(9));
  assert(sameCard(E.topDiscard(played), card('red', '7')));
  assertEqual(played.currentPlayer, 1);

  var passed = E.applyPass(g2);
  assertEqual(passed.players[0].hand.length, 2, 'card is kept');
  assertEqual(passed.currentPlayer, 1);
  assertValid(passed);
});

test('exhausting the draw pile reshuffles the discard minus its top card', function () {
  var g = E.createGame({ numPlayers: 2 }, seededRng(7));
  /* Empty the draw pile into the discard pile, keeping the original top on top. */
  g.discardPile = g.drawPile.concat(g.discardPile);
  g.drawPile = [];
  var top = E.topDiscard(g);
  var discardSize = g.discardPile.length;
  assertValid(g, 'rearranged state must still conserve cards');

  var g2 = E.applyDraw(g, seededRng(8));
  assert(sameCard(E.topDiscard(g2), top), 'top discard survives the reshuffle');
  assertEqual(g2.discardPile.length, 1, 'everything else went back to the draw pile');
  assertEqual(g2.drawPile.length, discardSize - 1 - 1, 'recycled cards minus the one drawn');
  assertEqual(g2.players[0].hand.length, 8);
  assertValid(g2);
});

test('drawing with both piles empty does not crash and passes the turn', function () {
  var g = E.createGame({ numPlayers: 2 }, seededRng(7));
  /* Pathological state: every card except the top discard is in hands. */
  g.players[0].hand = g.players[0].hand.concat(g.drawPile);
  g.drawPile = [];
  var handSize = g.players[0].hand.length;
  var g2 = E.applyDraw(g, seededRng(8));
  assertEqual(g2.players[0].hand.length, handSize, 'nothing to draw');
  assertEqual(g2.currentPlayer, 1);
  assertValid(g2);
});

/* ----- Uno calls and penalties ----- */

function twoCardSetup() {
  /* Player 0 holds two red cards on a red 5 top, so both are playable. */
  var hand = [card('red', '1'), card('red', '2')].concat(FILLER[0].slice(0, 5));
  var g = makeGame([hand, FILLER[1]], card('red', '5'));
  trimHand(g, 0, 2);
  return g;
}

test('reaching one card without declaring sets the pending flag', function () {
  var g = twoCardSetup();
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  assertEqual(g2.unoPending, 0);
  assertEqual(g2.players[0].calledUno, false);
});

test('declaring Uno with the play avoids any penalty', function () {
  var g = twoCardSetup();
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0, declareUno: true }, seededRng(9));
  assertEqual(g2.unoPending, null);
  assertEqual(g2.players[0].calledUno, true);
  var g3 = E.applyDraw(g2, seededRng(9));
  assertEqual(g3.players[0].hand.length, 1, 'no penalty after a proper call');
});

test('calling Uno inside the window (before the next player acts) is safe', function () {
  var g = twoCardSetup();
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  var g3 = E.callUno(g2, 0);
  assertEqual(g3.unoPending, null);
  var g4 = E.applyDraw(g3, seededRng(9));
  assertEqual(g4.players[0].hand.length, 1, 'no penalty after calling in time');
});

test('failing to call before the next player acts costs two cards', function () {
  var g = twoCardSetup();
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  var g3 = E.applyDraw(g2, seededRng(9));
  assertEqual(g3.players[0].hand.length, 3, 'one card plus the two-card penalty');
  assertEqual(g3.unoPending, null);
  assertValid(g3);
  assertThrows(function () { E.callUno(g3, 0); }, 'the window is closed');
});

test('the penalty also lands when the next player plays a card', function () {
  var hand0 = [card('red', '1'), card('red', '2')].concat(FILLER[0].slice(0, 5));
  var hand1 = [card('red', '9')].concat(FILLER[1].slice(0, 6));
  var g = makeGame([hand0, hand1], card('red', '5'));
  trimHand(g, 0, 2);
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  var g3 = E.applyPlay(g2, { type: 'play', playerIndex: 1, cardIndex: 0 }, seededRng(9));
  assertEqual(g3.players[0].hand.length, 3);
  assertValid(g3);
});

test('catchUno applies the penalty immediately', function () {
  var g = twoCardSetup();
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  var g3 = E.catchUno(g2, seededRng(9));
  assertEqual(g3.players[0].hand.length, 3);
  assertEqual(g3.unoPending, null);
  assertThrows(function () { E.catchUno(g3, seededRng(9)); }, 'nobody left to catch');
  assertValid(g3);
});

test('callUno is rejected when no call is pending', function () {
  var g = twoCardSetup();
  assertThrows(function () { E.callUno(g, 0); });
  assertThrows(function () { E.callUno(g, 1); });
});

/* ----- winning and scoring ----- */

test('emptying the hand ends the round and scores opponents\' cards', function () {
  var hand0 = [card('red', '1'), card('red', '2')].concat(FILLER[0].slice(0, 5));
  var hand1 = [card('blue', '9'), card('blue', 'skip'), card(null, 'wild')].concat(FILLER[1].slice(0, 4));
  var g = makeGame([hand0, hand1], card('red', '5'));
  trimHand(g, 0, 1);
  trimHand(g, 1, 3);
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0, declareUno: true }, seededRng(9));
  assertEqual(g2.phase, 'roundOver');
  assertEqual(g2.roundWinner, 0);
  assertEqual(g2.roundPoints, 9 + 20 + 50);
  assertEqual(g2.players[0].score, 79);
  assertValid(g2);
  assertThrows(function () { E.applyDraw(g2, seededRng(9)); }, 'no actions after the round ends');
});

test('a final Draw Two still makes the next player draw before scoring', function () {
  var hand0 = [card('red', 'draw2'), card('red', '2')].concat(FILLER[0].slice(0, 5));
  var g = makeGame([hand0, FILLER[1]], card('red', '5'));
  trimHand(g, 0, 1);
  var before = JSON.parse(JSON.stringify(g.players[1].hand));
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0, declareUno: true }, seededRng(9));
  assertEqual(g2.phase, 'roundOver');
  assertEqual(g2.players[1].hand.length, before.length + 2, 'penalty drawn before scoring');
  assert(g2.roundPoints >= E.handPoints(before), 'drawn cards count toward the score');
  assertValid(g2);
});

test('reaching the target score ends the game', function () {
  var hand0 = [card('red', '9'), card('red', '2')].concat(FILLER[0].slice(0, 5));
  var g = makeGame([hand0, FILLER[1]], card('red', '5'), { targetScore: 10 });
  trimHand(g, 0, 1);
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0, declareUno: true }, seededRng(9));
  assertEqual(g2.phase, 'gameOver');
  assertEqual(g2.gameWinner, 0);
  assertThrows(function () { E.startNextRound(g2, seededRng(9)); }, 'no next round after game over');
});

test('startNextRound re-deals and keeps scores', function () {
  var hand0 = [card('red', '9'), card('red', '2')].concat(FILLER[0].slice(0, 5));
  var g = makeGame([hand0, FILLER[1]], card('red', '5'));
  trimHand(g, 0, 1);
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0, declareUno: true }, seededRng(9));
  assertEqual(g2.phase, 'roundOver');
  var score = g2.players[0].score;
  var g3 = E.startNextRound(g2, seededRng(11));
  assertEqual(g3.phase, 'playing');
  assertEqual(g3.round, 2);
  assertEqual(g3.players[0].score, score, 'scores persist across rounds');
  g3.players.forEach(function (p) { assertEqual(p.hand.length, 7); });
  assertValid(g3);
});

/* ----- stacking house rule ----- */

test('stackDraws lets a Draw Two be answered and the total accumulate', function () {
  var hand0 = [card('red', 'draw2')].concat(FILLER[0].slice(0, 6));
  var hand1 = [card('blue', 'draw2')].concat(FILLER[1].slice(0, 6));
  var g = makeGame([hand0, hand1, FILLER[2]], card('red', '5'), { stackDraws: true });
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  assertEqual(g2.currentPlayer, 1, 'next player must answer, not skip');
  assertEqual(g2.pendingDrawCount, 2);
  var plays = E.legalPlays(g2, 1);
  assertEqual(plays.length, 1, 'only the matching draw card is playable');
  assertEqual(plays[0].card.value, 'draw2');
  var g3 = E.applyPlay(g2, { type: 'play', playerIndex: 1, cardIndex: plays[0].cardIndex }, seededRng(9));
  assertEqual(g3.pendingDrawCount, 4, 'the total accumulates');
  var g4 = E.applyDraw(g3, seededRng(9));
  assertEqual(g4.players[2].hand.length, 11, 'player 2 eats all four');
  assertEqual(g4.currentPlayer, 0);
  assertValid(g4);
});

test('without stackDraws the penalty resolves immediately', function () {
  var hand0 = [card('red', 'draw2')].concat(FILLER[0].slice(0, 6));
  var hand1 = [card('blue', 'draw2')].concat(FILLER[1].slice(0, 6));
  var g = makeGame([hand0, hand1, FILLER[2]], card('red', '5'));
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  assertEqual(g2.players[1].hand.length, 9);
  assertEqual(g2.currentPlayer, 2);
  assertEqual(g2.pendingDrawCount, 0);
});

/* ----- validator ----- */

test('validateState flags lost and duplicated cards', function () {
  var g = E.createGame({ numPlayers: 2 }, seededRng(3));
  assertValid(g);
  var lost = JSON.parse(JSON.stringify(g));
  lost.drawPile.pop();
  assert(E.validateState(lost).length > 0, 'a lost card must be flagged');
  var duped = JSON.parse(JSON.stringify(g));
  duped.drawPile.push(JSON.parse(JSON.stringify(duped.players[0].hand[0])));
  assert(E.validateState(duped).length > 0, 'a duplicated card must be flagged');
});

/* ----- full-game soak with seeded randomness ----- */

test('seeded random playouts finish with valid state at every step', function () {
  for (var seed = 100; seed < 130; seed++) {
    var rng = seededRng(seed);
    var s = E.createGame({ numPlayers: 2 + (seed % 3), targetScore: 200 }, rng);
    var steps = 0;
    while (s.phase !== 'gameOver' && steps < 20000) {
      steps++;
      if (s.phase === 'roundOver') { s = E.startNextRound(s, rng); continue; }
      var plays = E.legalPlays(s, s.currentPlayer);
      if (plays.length) {
        var pick = plays[Math.floor(rng() * plays.length)];
        var action = {
          type: 'play', playerIndex: s.currentPlayer, cardIndex: pick.cardIndex,
          declareUno: rng() < 0.8
        };
        if (E.isWild(pick.card)) action.chosenColor = E.COLORS[Math.floor(rng() * 4)];
        s = E.applyPlay(s, action, rng);
      } else if (s.pendingDraw) {
        s = E.applyPass(s);
      } else {
        s = E.applyDraw(s, rng);
      }
      var errors = E.validateState(s);
      assert(errors.length === 0, 'seed ' + seed + ' step ' + steps + ': ' + errors.join('; '));
    }
    assertEqual(s.phase, 'gameOver', 'seed ' + seed + ' must finish');
  }
});

/* ----- run ----- */

var failed = 0;
tests.forEach(function (t) {
  try {
    t.fn();
    console.log('ok    ' + t.name);
  } catch (e) {
    failed++;
    console.error('FAIL  ' + t.name);
    console.error('      ' + e.message);
  }
});
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' tests passed');
if (failed > 0) process.exit(1);
