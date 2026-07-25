/*
 * engine.test.js
 *
 * Zero-dependency test suite for the Uno engine. Run with:
 *   node engine.test.js
 *
 * The runner, seeded rng (mulberry32), and deck-stacking helpers live in
 * testutil.js, shared with ai.test.js so the two suites cannot drift.
 * All randomness comes from the seeded rng so every run is identical.
 * Where a test needs exact cards in exact places it uses the engine's
 * presetDeck hook (config._deck) or moves cards between zones of a real
 * game state, which keeps the 108-card conservation invariant intact so
 * validateState stays meaningful.
 */
'use strict';

var E = require('./engine.js');
var U = require('./testutil.js');

var test = U.test, run = U.run;
var assert = U.assert, assertEqual = U.assertEqual;
var assertThrows = U.assertThrows, assertValid = U.assertValid;
var seededRng = U.seededRng, card = U.card, sameCard = U.sameCard;
var makeGame = U.makeGame, FILLER = U.FILLER;
var trimHand = U.trimHand, moveToHand = U.moveToHand;

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

test('a rigged deck with only Wild Draw Fours to flip fails loudly instead of hanging', function () {
  var deck = [];
  for (var i = 0; i < 20; i++) deck.push(card(null, 'wild4'));
  assertThrows(function () {
    E.createGame({ numPlayers: 2, _deck: deck }, seededRng(1));
  }, 'an unstartable deck must throw, not spin forever');
});

test('a degenerate rng cannot spin the first-flip reshuffle forever', function () {
  /*
   * A constant rng of 0.75 makes a two-card shuffle a no-op, so the
   * honest re-flip procedure would draw the same Wild Draw Four forever;
   * the bounded retry must fall back to pulling the other card instead.
   */
  var deck = [card('red', '5'), card(null, 'wild4')];
  for (var i = 0; i < 14; i++) deck.push(card('green', String(1 + (i % 9))));
  var g = E.createGame({ numPlayers: 2, _deck: deck }, function () { return 0.75; });
  assert(sameCard(E.topDiscard(g), card('red', '5')), 'the non-wild4 card starts the discard');
  assertEqual(g.drawPile.length, 1, 'the wild4 stays in the draw pile');
  assertEqual(g.players[0].hand.length, 7);
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

test('the engine records an applied Uno penalty in state.unoPenalty', function () {
  var g = twoCardSetup();
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  assertEqual(g2.unoPenalty, null, 'no penalty yet, only the pending window');
  var g3 = E.applyDraw(g2, seededRng(9));
  assertEqual(g3.unoPenalty.player, 0);
  assertEqual(g3.unoPenalty.drew, 2);
  var g4 = g3.pendingDraw ? E.applyPass(g3) : E.applyDraw(g3, seededRng(10));
  assertEqual(g4.unoPenalty, null, 'the record does not outlive its transition');
});

test('catchUno records the penalty in state.unoPenalty too', function () {
  var g = twoCardSetup();
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  var g3 = E.catchUno(g2, seededRng(9));
  assertEqual(g3.unoPenalty.player, 0);
  assertEqual(g3.unoPenalty.drew, 2);
});

test('the window closing on the offender still applies the penalty', function () {
  /*
   * 2-player Reverse acts as Skip, so the pending player is the next to
   * act. Their whole between-actions gap was the chance to call Uno, so
   * acting again without calling costs the two cards like any other
   * closing of the window.
   */
  var hand = [card('red', 'reverse'), card('blue', '9')].concat(FILLER[0].slice(0, 5));
  var g = makeGame([hand, FILLER[1]], card('red', '5'));
  trimHand(g, 0, 2);
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  assertEqual(g2.unoPending, 0);
  assertEqual(g2.currentPlayer, 0, 'reverse acts as skip; same player again');
  var g3 = E.applyDraw(g2, seededRng(9));
  assertEqual(g3.unoPenalty.player, 0);
  assertEqual(g3.unoPenalty.drew, 2);
  assertEqual(g3.unoPending, null);
  assertEqual(g3.players[0].hand.length, 4, 'two penalty cards plus the voluntary draw');
  assertValid(g3);
});

test('in 2-player an action card is not a free pass around the Uno rule', function () {
  /* Playing Skip at two cards without calling, then playing out: the
   * penalty must land before the would-be winning card. */
  var hand = [card('red', 'skip'), card('red', '1')].concat(FILLER[0].slice(0, 5));
  var g = makeGame([hand, FILLER[1]], card('red', '5'));
  trimHand(g, 0, 2);
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  assertEqual(g2.currentPlayer, 0, 'skip returns the turn in 2-player');
  var g3 = E.applyPlay(g2, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  assertEqual(g3.phase, 'playing', 'no free win: the penalty landed first');
  assertEqual(g3.unoPenalty.player, 0);
  assertEqual(g3.players[0].hand.length, 2);
  assertEqual(g3.currentPlayer, 1);
  assertValid(g3);
});

test('calling Uno between your own turns keeps the win clean', function () {
  var hand = [card('red', 'skip'), card('red', '1')].concat(FILLER[0].slice(0, 5));
  var g = makeGame([hand, FILLER[1]], card('red', '5'));
  trimHand(g, 0, 2);
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  var g3 = E.callUno(g2, 0);
  var g4 = E.applyPlay(g3, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  assertEqual(g4.phase, 'roundOver');
  assertEqual(g4.roundWinner, 0);
  assertEqual(g4.unoPenalty, null);
  assertValid(g4);
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

test('stackDraws: a winning final Draw Two still lands on the opponent before scoring', function () {
  var hand0 = [card('red', 'draw2'), card('red', '2')].concat(FILLER[0].slice(0, 5));
  var g = makeGame([hand0, FILLER[1]], card('red', '5'), { stackDraws: true });
  trimHand(g, 0, 1);
  var before = g.players[1].hand.length;
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0, declareUno: true }, seededRng(9));
  assertEqual(g2.phase, 'roundOver');
  assertEqual(g2.players[1].hand.length, before + 2, 'the deferred two cards land before scoring');
  assertEqual(g2.pendingDrawCount, 0);
  assertEqual(g2.roundPoints, E.handPoints(g2.players[1].hand), 'drawn cards count toward the score');
  assertValid(g2);
});

test('stackDraws: winning by answering a stack makes the next player eat the whole total', function () {
  var hand0 = [card('red', 'draw2')].concat(FILLER[0].slice(0, 6));
  var hand1 = [card('blue', 'draw2'), card('blue', '9')].concat(FILLER[1].slice(0, 5));
  var g = makeGame([hand0, hand1, FILLER[2]], card('red', '5'), { stackDraws: true });
  trimHand(g, 1, 1);
  var g2 = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0 }, seededRng(9));
  assertEqual(g2.pendingDrawCount, 2);
  assertEqual(g2.currentPlayer, 1);
  var g3 = E.applyPlay(g2, { type: 'play', playerIndex: 1, cardIndex: 0 }, seededRng(9));
  assertEqual(g3.phase, 'roundOver');
  assertEqual(g3.roundWinner, 1);
  assertEqual(g3.players[2].hand.length, 11, 'player 2 draws the accumulated four');
  assertEqual(g3.pendingDrawCount, 0);
  assertValid(g3);
});

test('stackDraws: a first-flip Draw Two may be answered instead of eaten', function () {
  var hand = [card('green', 'draw2')].concat(FILLER[0].slice(0, 6));
  var g = makeGame([hand, FILLER[1]], card('red', 'draw2'), { stackDraws: true });
  assertEqual(g.players[0].hand.length, 7, 'no forced draw yet');
  assertEqual(g.currentPlayer, 0, 'the first player leads and must answer');
  assertEqual(g.pendingDrawCount, 2);
  assertEqual(g.pendingDrawValue, 'draw2');
  var plays = E.legalPlays(g, 0);
  assertEqual(plays.length, 1, 'only a Draw Two answers the stack');
  assertEqual(plays[0].card.value, 'draw2');
  var answered = E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: plays[0].cardIndex }, seededRng(9));
  assertEqual(answered.pendingDrawCount, 4, 'the total accumulates onto the opponent');
  assertEqual(answered.currentPlayer, 1);
  assertValid(answered);
  var declined = E.applyDraw(g, seededRng(9));
  assertEqual(declined.players[0].hand.length, 9, 'declining still eats the two');
  assertEqual(declined.currentPlayer, 1);
  assertEqual(declined.pendingDrawCount, 0);
  assertValid(declined);
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

/* ----- Wild Draw Four challenge rule ----- */

/*
 * Player 0 leads on a red 5 holding a Wild Draw Four at index 0; rest0
 * is the other six cards, which is exactly what the challenge rule
 * judges the play against. The flag is on unless config says otherwise.
 */
function wild4Setup(rest0, config) {
  config = config || {};
  if (config.challengeRule === undefined) config.challengeRule = true;
  return makeGame([[card(null, 'wild4')].concat(rest0), FILLER[1]], card('red', '5'), config);
}

function playWild4(g, color) {
  return E.applyPlay(g, { type: 'play', playerIndex: 0, cardIndex: 0, chosenColor: color }, seededRng(9));
}

test('challenge rule off: a Wild Draw Four still resolves immediately', function () {
  var g = wild4Setup(FILLER[0].slice(0, 6), { challengeRule: false });
  var g2 = playWild4(g, 'green');
  assertEqual(g2.pendingChallenge, null, 'no window opens');
  assertEqual(g2.pendingDrawCount, 0);
  assertEqual(g2.players[1].hand.length, 11, 'the victim drew straight away');
  assertEqual(g2.currentPlayer, 0, 'and lost the turn');
  assertValid(g2);
});

test('a guilty Wild Draw Four is handed back to the offender', function () {
  var g = wild4Setup([card('red', '3')].concat(FILLER[0].slice(0, 5)));
  var g2 = playWild4(g, 'green');
  assertEqual(g2.pendingChallenge.offender, 0);
  assertEqual(g2.pendingChallenge.victim, 1);
  assertEqual(g2.pendingChallenge.color, 'red', 'judged against the color the wild had to beat');
  assertEqual(g2.pendingChallenge.hadColorMatch, true);
  assertEqual(g2.pendingChallenge.colorMatches, 1);
  assertEqual(g2.pendingChallenge.amount, 4);
  assertEqual(g2.pendingDrawCount, 4, 'deferred, not drawn');
  assertEqual(g2.players[1].hand.length, 7, 'nobody has drawn anything yet');
  assertEqual(g2.currentPlayer, 1, 'the victim owes a decision');
  assertValid(g2);

  var g3 = E.applyChallenge(g2, seededRng(9));
  assertEqual(g3.players[0].hand.length, 10, 'six left plus the four it tried to hand out');
  assertEqual(g3.players[1].hand.length, 7, 'the victim draws nothing');
  assertEqual(g3.currentPlayer, 1, 'and is not skipped');
  assertEqual(g3.currentColor, 'green', 'the declared color stands');
  assert(sameCard(E.topDiscard(g3), card(null, 'wild4')), 'the card stays on the pile');
  assertEqual(g3.pendingChallenge, null);
  assertEqual(g3.pendingDrawCount, 0);
  assertEqual(g3.challengeResult.guilty, true);
  assertEqual(g3.challengeResult.challenger, 1);
  assertEqual(g3.challengeResult.offender, 0);
  assertEqual(g3.challengeResult.colorMatches, 1);
  assertEqual(g3.challengeResult.color, 'red');
  assertEqual(g3.challengeResult.drew, 4);
  assertValid(g3);
});

test('a failed challenge costs the challenger six cards and their turn', function () {
  var g = wild4Setup(FILLER[0].slice(0, 6));
  var g2 = playWild4(g, 'green');
  assertEqual(g2.pendingChallenge.hadColorMatch, false, 'a hand of greens on a red 5 is clean');
  assertEqual(g2.pendingChallenge.colorMatches, 0);
  var g3 = E.applyChallenge(g2, seededRng(9));
  assertEqual(g3.players[1].hand.length, 13, 'the four plus two more');
  assertEqual(g3.players[0].hand.length, 6, 'the offender keeps their hand');
  assertEqual(g3.currentPlayer, 0, 'the challenger is skipped');
  assertEqual(g3.challengeResult.guilty, false);
  assertEqual(g3.challengeResult.drew, 6);
  assertValid(g3);
});

test('accepting a Wild Draw Four draws four and skips the victim', function () {
  var g = wild4Setup(FILLER[0].slice(0, 6));
  var g2 = playWild4(g, 'green');
  var g3 = E.applyDraw(g2, seededRng(9));
  assertEqual(g3.players[1].hand.length, 11);
  assertEqual(g3.currentPlayer, 0, 'the victim loses the turn');
  assertEqual(g3.pendingChallenge, null);
  assertEqual(g3.pendingDrawCount, 0);
  assertEqual(g3.challengeResult, null, 'accepting is not a challenge');
  assertValid(g3);
});

test('guilt is judged on the pre-wild color and the hand left behind', function () {
  /*
   * Matching the top by value is not a color match: a blue 5 on a red 5
   * is a legal play to make, but it is not the red the wild had to dodge.
   */
  var byValue = playWild4(wild4Setup([card('blue', '5')].concat(FILLER[0].slice(0, 5))), 'green');
  assertEqual(byValue.pendingChallenge.hadColorMatch, false);
  assertValid(byValue);

  /* Wilds carry a null color, so they never count against their holder. */
  var withWild = playWild4(wild4Setup([card(null, 'wild')].concat(FILLER[0].slice(0, 5))), 'green');
  assertEqual(withWild.pendingChallenge.colorMatches, 0);
  assertEqual(withWild.pendingChallenge.hadColorMatch, false);
  assertValid(withWild);

  /* One card of the active color is all it takes, whatever its value. */
  var held = playWild4(
    wild4Setup([card('red', 'skip'), card('red', '3')].concat(FILLER[0].slice(0, 4))), 'green');
  assertEqual(held.pendingChallenge.colorMatches, 2);
  assertEqual(held.pendingChallenge.hadColorMatch, true);
  assertValid(held);
});

test('the guilt snapshot is never recomputed from the hand as it later stands', function () {
  var g2 = playWild4(wild4Setup(FILLER[0].slice(0, 6)), 'green');
  assertEqual(g2.pendingChallenge.hadColorMatch, false);
  /*
   * The offender picks up a red card while the window is open. The
   * verdict must still be the one taken when the card hit the table.
   */
  moveToHand(g2, 0, card('red', '3'));
  assertValid(g2, 'moving a card between zones keeps conservation');
  var g3 = E.applyChallenge(g2, seededRng(9));
  assertEqual(g3.challengeResult.guilty, false, 'judged as of play time');
  assertEqual(g3.players[1].hand.length, 13, 'so the challenger pays');
  assertValid(g3);
});

test('a Wild Draw Four played on a null color is legal by definition', function () {
  /*
   * The round opened on a flipped Wild, so there is no active color to
   * dodge: the first play cannot be a bluff, whatever the hand holds.
   */
  var hand0 = [card(null, 'wild4'), card('red', '3'), card('red', '4')].concat(FILLER[0].slice(0, 4));
  var g = makeGame([hand0, FILLER[1]], card(null, 'wild'), { challengeRule: true });
  assertEqual(g.currentColor, null);
  assertEqual(g.currentPlayer, 0);
  var g2 = playWild4(g, 'green');
  assertEqual(g2.pendingChallenge.color, null);
  assertEqual(g2.pendingChallenge.colorMatches, 0, 'two reds are still no match for no color');
  assertEqual(g2.pendingChallenge.hadColorMatch, false);
  assertValid(g2);
  var g3 = E.applyChallenge(g2, seededRng(9));
  assertEqual(g3.challengeResult.guilty, false);
  assertEqual(g3.players[1].hand.length, 13);
  assertValid(g3);
});

test('a Wild Draw Four played last leaves the round open until the window resolves', function () {
  var g = wild4Setup(FILLER[0].slice(0, 6));
  trimHand(g, 0, 1);
  var g2 = playWild4(g, 'green');
  assertEqual(g2.phase, 'playing', 'the round is not over yet');
  assertEqual(g2.roundWinner, null);
  assertEqual(g2.players[0].hand.length, 0);
  assert(g2.pendingChallenge, 'the victim still owes a decision');
  assertValid(g2);

  var accepted = E.applyDraw(g2, seededRng(9));
  assertEqual(accepted.phase, 'roundOver');
  assertEqual(accepted.roundWinner, 0);
  assertEqual(accepted.players[1].hand.length, 11, 'the four land before scoring');
  assertEqual(accepted.roundPoints, E.handPoints(accepted.players[1].hand), 'drawn cards count');
  assertValid(accepted);

  var failed = E.applyChallenge(g2, seededRng(9));
  assertEqual(failed.phase, 'roundOver');
  assertEqual(failed.roundWinner, 0);
  assertEqual(failed.players[1].hand.length, 13, 'six for the failed challenge');
  assertEqual(failed.roundPoints, E.handPoints(failed.players[1].hand));
  assertValid(failed);
});

test('a successful challenge takes back a win and the round continues', function () {
  /*
   * Legal play cannot reach this: guilt is judged on the hand left after
   * the Wild Draw Four is removed, so going out on one always leaves an
   * empty, and therefore clean, hand. The reversal still has to be right,
   * so the offender's last card is moved out while the window is open,
   * leaving a guilty verdict standing over an empty hand.
   */
  var g = wild4Setup([card('red', '3')].concat(FILLER[0].slice(0, 5)));
  trimHand(g, 0, 2);
  var g2 = E.applyPlay(g,
    { type: 'play', playerIndex: 0, cardIndex: 0, chosenColor: 'green', declareUno: true },
    seededRng(9));
  assertEqual(g2.pendingChallenge.hadColorMatch, true);
  trimHand(g2, 0, 0);
  assertEqual(g2.players[0].hand.length, 0);
  assertValid(g2);

  var g3 = E.applyChallenge(g2, seededRng(9));
  assertEqual(g3.phase, 'playing', 'no winner after all');
  assertEqual(g3.roundWinner, null);
  assertEqual(g3.players[0].hand.length, 4, 'the four come back into the hand');
  assertEqual(g3.currentPlayer, 1, 'the victim takes their normal turn');
  assertEqual(g3.challengeResult.guilty, true);
  assertValid(g3);
});

test('the Uno window survives a challenge window, lazily and through catchUno', function () {
  var hand0 = [card(null, 'wild4'), card('red', '3')].concat(FILLER[0].slice(0, 5));
  var g = makeGame([hand0, FILLER[1]], card('red', '5'), { challengeRule: true });
  trimHand(g, 0, 2);
  var g2 = playWild4(g, 'green');
  assertEqual(g2.unoPending, 0, 'second to last card played without a call');
  assert(g2.pendingChallenge, 'and the window is open');
  assertValid(g2);

  /* Caught inside the window, which leaves the decision still owed. */
  var caught = E.catchUno(g2, seededRng(9));
  assertEqual(caught.unoPenalty.player, 0);
  assertEqual(caught.unoPenalty.drew, 2);
  assertEqual(caught.players[0].hand.length, 3);
  assert(caught.pendingChallenge, 'the challenge is untouched');
  assertEqual(caught.currentPlayer, 1);
  assertValid(caught);
  var challenged = E.applyChallenge(caught, seededRng(9));
  assertEqual(challenged.challengeResult.guilty, true, 'the snapshot, not the swollen hand');
  assertEqual(challenged.players[0].hand.length, 7, 'three plus the four handed back');
  assertValid(challenged);

  /* Or lazily: the victim's decision closes both windows in one action. */
  var lazy = E.applyChallenge(g2, seededRng(9));
  assertEqual(lazy.unoPenalty.player, 0);
  assertEqual(lazy.unoPenalty.drew, 2);
  assertEqual(lazy.challengeResult.guilty, true);
  assertEqual(lazy.players[0].hand.length, 7, 'the same two costs in the same order');
  assertValid(lazy);

  /* Accepting closes it too. */
  var accepted = E.applyDraw(g2, seededRng(9));
  assertEqual(accepted.unoPenalty.player, 0);
  assertEqual(accepted.players[0].hand.length, 3);
  assertEqual(accepted.players[1].hand.length, 11);
  assertValid(accepted);
});

test('a challenge window freezes ordinary play until it is answered', function () {
  var hand0 = [card(null, 'wild4')].concat(FILLER[0].slice(0, 6));
  var hand1 = [card('green', '9')].concat(FILLER[1].slice(0, 6));
  var g = makeGame([hand0, hand1], card('red', '5'), { challengeRule: true });
  assertThrows(function () { E.applyChallenge(g, seededRng(9)); }, 'nothing to challenge yet');
  var g2 = playWild4(g, 'green');
  assertEqual(E.legalPlays(g2, 1).length, 0, 'the green 9 it could otherwise play is frozen');
  assertEqual(E.legalPlays(g2, 0).length, 0, 'and the offender is not on turn');
  assertThrows(function () {
    E.applyPlay(g2, { type: 'play', playerIndex: 1, cardIndex: 0 }, seededRng(9));
  }, 'playing through the window must be rejected');
  assertThrows(function () { E.applyPass(g2); }, 'there is no drawn card to keep');
  var g3 = E.applyDraw(g2, seededRng(9));
  assertThrows(function () { E.applyChallenge(g3, seededRng(9)); }, 'the window is closed');
  assertValid(g3);
});

test('stacking: answering a Wild Draw Four grows the total and re-judges guilt', function () {
  var hand0 = [card(null, 'wild4'), card('red', '3')].concat(FILLER[0].slice(0, 5));
  var hand1 = [card(null, 'wild4')].concat(FILLER[1].slice(0, 6));
  var g = makeGame([hand0, hand1, FILLER[2]], card('red', '5'),
    { challengeRule: true, stackDraws: true });
  var g2 = playWild4(g, 'green');
  assertEqual(g2.pendingChallenge.hadColorMatch, true, 'player 0 still held a red');
  assertEqual(g2.pendingDrawCount, 4);

  var plays = E.legalPlays(g2, 1);
  assertEqual(plays.length, 1, 'only another Wild Draw Four answers');
  assertEqual(plays[0].card.value, 'wild4');

  var g3 = E.applyPlay(g2,
    { type: 'play', playerIndex: 1, cardIndex: plays[0].cardIndex, chosenColor: 'blue' }, seededRng(9));
  assertEqual(g3.pendingDrawCount, 8, 'the total grows by four');
  assertEqual(g3.pendingChallenge.offender, 1, 'a fresh window for a fresh offender');
  assertEqual(g3.pendingChallenge.victim, 2);
  assertEqual(g3.pendingChallenge.color, 'green', 'judged against the color player 0 declared');
  assertEqual(g3.pendingChallenge.hadColorMatch, false, 'a hand of blues is clean against green');
  assertEqual(g3.pendingChallenge.amount, 8);
  assertValid(g3);

  var accepted = E.applyDraw(g3, seededRng(9));
  assertEqual(accepted.players[2].hand.length, 15, 'the whole total lands at once');
  assertEqual(accepted.currentPlayer, 0);
  assertValid(accepted);

  var failed = E.applyChallenge(g3, seededRng(9));
  assertEqual(failed.players[2].hand.length, 17, 'the total plus two');
  assertEqual(failed.currentPlayer, 0, 'and the challenger is skipped');
  assertValid(failed);
});

test('stacking: a successful challenge moves the whole total to the last offender', function () {
  var hand0 = [card(null, 'wild4'), card('red', '3')].concat(FILLER[0].slice(0, 5));
  var hand1 = [card(null, 'wild4'), card('green', '9')].concat(FILLER[1].slice(0, 5));
  var g = makeGame([hand0, hand1, FILLER[2]], card('red', '5'),
    { challengeRule: true, stackDraws: true });
  var g2 = playWild4(g, 'green');
  var g3 = E.applyPlay(g2,
    { type: 'play', playerIndex: 1, cardIndex: 0, chosenColor: 'blue' }, seededRng(9));
  assertEqual(g3.pendingChallenge.hadColorMatch, true, 'player 1 kept a green');
  assertEqual(g3.pendingChallenge.colorMatches, 1);
  var g4 = E.applyChallenge(g3, seededRng(9));
  assertEqual(g4.players[1].hand.length, 14, 'six left plus all eight');
  assertEqual(g4.players[2].hand.length, 7, 'the challenger draws nothing');
  assertEqual(g4.currentPlayer, 2, 'and keeps the turn');
  assertEqual(g4.players[0].hand.length, 6, 'the first offender is off the hook');
  assertEqual(g4.pendingDrawCount, 0);
  assertValid(g4);
});

test('seeded playouts with the challenge rule on stay valid at every step', function () {
  for (var seed = 300; seed < 330; seed++) {
    var rng = seededRng(seed);
    var s = E.createGame({
      numPlayers: 2 + (seed % 3),
      targetScore: 200,
      challengeRule: true,
      /* Half the seeds also stack, which is where the totals grow. */
      stackDraws: seed % 2 === 0
    }, rng);
    var steps = 0;
    while (s.phase !== 'gameOver' && steps < 20000) {
      steps++;
      if (s.phase === 'roundOver') { s = E.startNextRound(s, rng); continue; }
      if (s.pendingChallenge && rng() < 0.5) {
        s = E.applyChallenge(s, rng);
      } else {
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
      }
      var errors = E.validateState(s);
      assert(errors.length === 0, 'seed ' + seed + ' step ' + steps + ': ' + errors.join('; '));
    }
    assertEqual(s.phase, 'gameOver', 'seed ' + seed + ' must finish');
  }
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
    var s = E.createGame({
      numPlayers: 2 + (seed % 3),
      targetScore: 200,
      /* Exercise the stacking mode too; its round-end resolution draws cards. */
      stackDraws: seed % 5 === 0
    }, rng);
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

run();
