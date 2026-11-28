/*
 * narrate.test.js
 *
 * The message bar's words, checked against real engine transitions
 * rather than hand-built states wherever a move can produce the case,
 * so a change in what the engine records shows up here as wrong words.
 */
'use strict';

var E = require('./engine.js');
var N = require('./narrate.js');
var U = require('./testutil.js');

var test = U.test, run = U.run;
var assertEqual = U.assertEqual;
var card = U.card, seededRng = U.seededRng, makeGame = U.makeGame, FILLER = U.FILLER;

function play(g, seat, cardIndex, color, uno) {
  return E.applyPlay(g, { type: 'play', playerIndex: seat, cardIndex: cardIndex, chosenColor: color, declareUno: uno },
    seededRng(9));
}

/* Moves a draw-pile card to the top, so the next draw deals it. */
function toTop(state, spec) {
  for (var i = 0; i < state.drawPile.length; i++) {
    if (U.sameCard(state.drawPile[i], spec)) {
      state.drawPile.push(state.drawPile.splice(i, 1)[0]);
      return state;
    }
  }
  throw new Error('toTop: card not in draw pile');
}

/* Leaves only `keep` cards to draw, parking the rest in seat 1's hand. */
function nearlyEmptyPiles(state, keep) {
  var moved = state.drawPile.splice(0, state.drawPile.length - keep);
  state.players[1].hand = state.players[1].hand.concat(moved);
  return state;
}

/* Two players; the human plays a red 3, then CPU 1 plays a Wild Draw Four at them. */
function wild4AtHuman(humanExtra, config) {
  var hand0 = [card('red', '3')].concat(humanExtra || [], FILLER[0]).slice(0, 7);
  var hand1 = [card(null, 'wild4')].concat(FILLER[1].slice(0, 6));
  var g = makeGame([hand0, hand1], card('red', '5'), config || { challengeRule: true });
  return play(play(g, 0, 0), 1, 0, 'green');
}

/* The human leads facing a flipped Draw Two under stacking. */
function draw2Flip(hand0) {
  return makeGame([hand0, FILLER[1]], card('red', 'draw2'), { stackDraws: true });
}

/* ----- owed ----- */

test('owed is the total the player on turn must answer or take', function () {
  assertEqual(N.owed(makeGame([FILLER[0], FILLER[1]], card('red', '5'))), 0, 'nothing pending');
  assertEqual(N.owed(wild4AtHuman()), 4, 'a challenge window holds four');
  assertEqual(N.owed(draw2Flip(FILLER[0])), 2, 'a stack holds its total');
  var noStack = makeGame([FILLER[0], FILLER[1]], card('red', 'draw2'));
  assertEqual(noStack.players[0].hand.length, 9, 'precondition: without stacking the Draw Two is dealt at once');
  assertEqual(N.owed(noStack), 0, 'so nothing is owed');
});

/* ----- prompt ----- */

test('a Wild Draw Four window asks to challenge or take', function () {
  var g = wild4AtHuman();
  assertEqual(N.prompt(g), 'Challenge the Wild Draw Four, or take 4?');
});

test('under stacking the window also offers an answer, but only with a Wild Draw Four in hand', function () {
  var cfg = { challengeRule: true, stackDraws: true };
  assertEqual(N.prompt(wild4AtHuman([card(null, 'wild4')], cfg)),
    'Challenge the Wild Draw Four, answer with your own, or take 4?');
  assertEqual(N.prompt(wild4AtHuman([], cfg)), 'Challenge the Wild Draw Four, or take 4?');
});

test('no answer is offered to an offender who played their last card', function () {
  var hand0 = [card('red', '3'), card(null, 'wild4')].concat(FILLER[0].slice(0, 5));
  var hand1 = [card(null, 'wild4')].concat(FILLER[1].slice(0, 6));
  var g = makeGame([hand0, hand1], card('red', '5'), { challengeRule: true, stackDraws: true });
  U.trimHand(g, 1, 1);
  var g2 = play(play(g, 0, 0), 1, 0, 'green');
  assertEqual(g2.players[1].hand.length, 0, 'precondition: CPU 1 went out on it');
  assertEqual(N.prompt(g2), 'Challenge the Wild Draw Four, or take 4?');
});

test('a stack asks to answer or take, or says plainly that it must be taken', function () {
  assertEqual(N.prompt(draw2Flip([card('green', 'draw2')].concat(FILLER[0].slice(0, 6)))),
    'Answer with a Draw Two, or take 2?');
  assertEqual(N.prompt(draw2Flip(FILLER[0])), 'You have no Draw Two to answer with: take 2.');
});

test('a stack of Wild Draw Fours names the card that answers it', function () {
  var hand0 = [card(null, 'wild4'), card(null, 'wild4')].concat(FILLER[0].slice(0, 5));
  var hand1 = [card(null, 'wild4')].concat(FILLER[1].slice(0, 6));
  var g = makeGame([hand0, hand1], card('red', '5'), { challengeRule: true, stackDraws: true });
  var g2 = play(play(g, 0, 0, 'green'), 1, 0, 'blue');
  assertEqual(g2.pendingChallenge, null, 'precondition: the answer opened no window');
  assertEqual(N.prompt(g2), 'Answer with a Wild Draw Four, or take 8?');
});

test('nothing is asked of a CPU, or when nothing is owed', function () {
  var cpuOwes = play(draw2Flip([card('green', 'draw2')].concat(FILLER[0].slice(0, 6))), 0, 0);
  assertEqual(cpuOwes.currentPlayer, 1);
  assertEqual(N.owed(cpuOwes), 4);
  assertEqual(N.prompt(cpuOwes), '');
  assertEqual(N.prompt(makeGame([FILLER[0], FILLER[1]], card('red', '5'))), '');
});

/* ----- blockedNote ----- */

test('a blocked tap points at the decision owed, whatever was tapped', function () {
  var g = draw2Flip(FILLER[0]);
  assertEqual(N.blockedNote(g, 'pile'), 'You have no Draw Two to answer with: take 2.');
  assertEqual(N.blockedNote(g, 'card'), 'You have no Draw Two to answer with: take 2.');
  assertEqual(N.blockedNote(wild4AtHuman(), 'pile'), 'Challenge the Wild Draw Four, or take 4?');
});

test('otherwise a blocked tap explains the drawn card or the mismatch', function () {
  var g = toTop(makeGame([FILLER[0], FILLER[1]], card('green', '5')), card('green', '9'));
  var drew = E.applyDraw(g, seededRng(9));
  assertEqual(drew.pendingDraw !== null, true, 'precondition: the drawn card is playable');
  assertEqual(N.blockedNote(drew, 'pile'), 'You already drew: play the card or keep it.');
  assertEqual(N.blockedNote(drew, 'card'), 'Only the drawn card can be played now.');
  assertEqual(N.blockedNote(makeGame([FILLER[0], FILLER[1]], card('red', '5')), 'card'), "That card doesn't match.");
});

/* ----- playNote ----- */

test('a play names the player, the card, any declared color, and an Uno call', function () {
  var hand0 = [card('red', '3'), card(null, 'wild4')].concat(FILLER[0].slice(0, 5));
  var g = makeGame([hand0, [card(null, 'wild')].concat(FILLER[1].slice(0, 6))], card('red', '5'));
  assertEqual(N.playNote(g, { type: 'play', playerIndex: 0, cardIndex: 0 }), 'You play red 3.');
  assertEqual(N.playNote(g, { type: 'play', playerIndex: 0, cardIndex: 1, chosenColor: 'blue', declareUno: true }),
    'You play wild +4, choosing blue. UNO!');
  var g2 = play(g, 0, 0);
  assertEqual(N.playNote(g2, { type: 'play', playerIndex: 1, cardIndex: 0, chosenColor: 'green' }),
    'CPU 1 plays wild WILD, choosing green.');
});

/* ----- drawNote ----- */

test('drawing one card says so, and says when it can be played', function () {
  var g = makeGame([FILLER[0], FILLER[1]], card('red', '5'));
  var miss = E.applyDraw(toTop(g, card('blue', '9')), seededRng(9));
  assertEqual(N.drawNote(g, miss), 'You draw a card; turn passes.');
  var g2 = makeGame([FILLER[0], FILLER[1]], card('red', '5'));
  var hit = E.applyDraw(toTop(g2, card('red', '9')), seededRng(9));
  assertEqual(N.drawNote(g2, hit), 'You drew a playable card: play it or keep it.');
  var cpuTurn = E.applyPass(hit);
  assertEqual(N.drawNote(cpuTurn, E.applyDraw(cpuTurn, seededRng(9))), 'CPU 1 draws a card.');
});

test('taking a stack or a Wild Draw Four says how many, never "a card"', function () {
  var g = draw2Flip(FILLER[0]);
  assertEqual(N.drawNote(g, E.applyDraw(g, seededRng(9))), 'You take 2.');
  var cpuOwes = play(draw2Flip([card('green', 'draw2')].concat(FILLER[0].slice(0, 6))), 0, 0);
  assertEqual(N.drawNote(cpuOwes, E.applyDraw(cpuOwes, seededRng(9))), 'CPU 1 takes 4.');
  var w = wild4AtHuman();
  assertEqual(N.drawNote(w, E.applyDraw(w, seededRng(9))), 'You take 4.');
});

test('a take cut short by empty piles says how many arrived', function () {
  var g = nearlyEmptyPiles(draw2Flip(FILLER[0]), 1);
  var took = E.applyDraw(g, seededRng(9));
  assertEqual(took.players[0].hand.length, 8, 'precondition: one card was there to take');
  assertEqual(N.drawNote(g, took), 'You take 1 of 2; the piles ran out.');
});

test('a draw with nothing left to draw says so', function () {
  var g = nearlyEmptyPiles(makeGame([FILLER[0], FILLER[1]], card('red', '5')), 0);
  var after = E.applyDraw(g, seededRng(9));
  assertEqual(N.drawNote(g, after), 'No cards left to draw; turn passes.');
  assertEqual(N.drawNote(after, E.applyDraw(after, seededRng(9))), 'CPU 1 has nothing left to draw.');
});

test("an Uno penalty dealt in the same move is not counted as the draw", function () {
  /*
   * Two players: the human's Skip leaves them one card without a call
   * and hands them the turn straight back, so their own draw is the
   * action that enforces the penalty on them. With one card left to
   * draw and one to recycle, the penalty takes both and the draw itself
   * finds nothing, so the hand grew by two yet nothing was drawn.
   */
  var hand0 = [card('red', 'skip'), card('green', '9')].concat(FILLER[0].slice(0, 5));
  var g = makeGame([hand0, FILLER[1]], card('red', '5'));
  U.trimHand(g, 0, 2);
  var g2 = nearlyEmptyPiles(play(g, 0, 0, undefined, false), 1);
  assertEqual(g2.currentPlayer, 0, 'precondition: the Skip handed the turn back');
  var after = E.applyDraw(g2, seededRng(9));
  assertEqual(after.unoPenalty.player, 0);
  assertEqual(after.unoPenalty.drew, 2);
  assertEqual(after.players[0].hand.length - g2.players[0].hand.length, 2, 'precondition: only the penalty arrived');
  assertEqual(N.drawNote(g2, after), 'No cards left to draw; turn passes.');
  assertEqual(N.message(after, N.drawNote(g2, after)), 'You missed UNO and draw 2! No cards left to draw; turn passes.');
});

test("a penalty on someone else does not shrink a take", function () {
  /*
   * The human plays a Draw Two as their second to last card without
   * calling Uno, and CPU 1's take is the action that enforces it. The
   * two penalty cards are the human's, not CPU 1's.
   */
  var hand0 = [card('red', 'draw2'), card('green', '9')].concat(FILLER[0].slice(0, 5));
  var g = makeGame([hand0, FILLER[1]], card('red', '5'), { stackDraws: true });
  U.trimHand(g, 0, 2);
  var g2 = play(g, 0, 0, undefined, false);
  var after = E.applyDraw(g2, seededRng(9));
  assertEqual(after.unoPenalty.player, 0, 'precondition: the penalty fell on the human');
  assertEqual(N.drawNote(g2, after), 'CPU 1 takes 2.');
});

/* ----- challenges and penalties ----- */

test('challenge calls and verdicts read from the engine record', function () {
  assertEqual(N.challengeCall(0), 'You challenge the Wild Draw Four.');
  assertEqual(N.challengeCall(2), 'CPU 2 challenges the Wild Draw Four!');
  var failed = E.applyChallenge(wild4AtHuman(), seededRng(9));
  assertEqual(N.challengeNote(failed.challengeResult), 'Challenge failed: CPU 1 had no red to play. You draw 6.');
  var hand1 = [card(null, 'wild4'), card('red', '8')].concat(FILLER[1].slice(0, 5));
  var g = makeGame([[card('red', '3')].concat(FILLER[0].slice(0, 6)), hand1], card('red', '5'), { challengeRule: true });
  var upheld = E.applyChallenge(play(play(g, 0, 0), 1, 0, 'green'), seededRng(9));
  assertEqual(N.challengeNote(upheld.challengeResult), 'Challenge upheld: CPU 1 held 1 red card it could have played, and draws 4.');
  assertEqual(N.challengeNote({ challenger: 1, offender: 0, guilty: false, color: null, colorMatches: 0, drew: 6 }),
    'Challenge failed: there was no color in play to match. CPU 1 draws 6.');
  assertEqual(N.challengeNote({ challenger: 1, offender: 0, guilty: true, color: 'blue', colorMatches: 2, drew: 4 }),
    'Challenge upheld: You held 2 blue cards you could have played, and draw 4.');
});

test('a failed challenge never says the offender held no red while penalty reds sit in their hand', function () {
  /*
   * The human's red Skip hands them the turn back with an uncalled Uno.
   * Their draw deals the two-card penalty, two reds, then a Wild Draw
   * Four, which they play. Those reds are in their hand, but they could
   * not have been played instead, so the challenge fails, and the words
   * must not deny the reds.
   */
  var hand0 = [card('red', 'skip'), card('green', '9')].concat(FILLER[0].slice(0, 5));
  var g = makeGame([hand0, FILLER[1]], card('red', '5'), { challengeRule: true });
  U.trimHand(g, 0, 2);
  var g2 = play(g, 0, 0, undefined, false);
  toTop(toTop(toTop(g2, card(null, 'wild4')), card('red', '8')), card('red', '7'));
  var drew = E.applyDraw(g2, seededRng(9));
  var g3 = play(drew, 0, drew.pendingDraw.cardIndex, 'blue');
  var after = E.applyChallenge(g3, seededRng(9));
  assertEqual(after.players[0].hand.filter(function (c) { return c.color === 'red'; }).length, 2,
    'precondition: the penalty reds are in the human\'s hand');
  assertEqual(N.challengeNote(after.challengeResult), 'Challenge failed: You had no red to play. CPU 1 draws 6.');
});

test('an Uno penalty names who missed and how many they drew', function () {
  assertEqual(N.penaltyNote({ player: 2, drew: 2 }), 'CPU 2 missed UNO and draws 2!');
  assertEqual(N.penaltyNote({ player: 0, drew: 1 }), 'You missed UNO and draw 1!');
});

/* ----- message ----- */

test('a message joins the move, the verdict, and what the human owes next', function () {
  var hand1 = [card(null, 'wild4')].concat(FILLER[1].slice(0, 6));
  var g = makeGame([[card('red', '3')].concat(FILLER[0].slice(0, 6)), hand1], card('red', '5'), { challengeRule: true });
  var g2 = play(g, 0, 0);
  var action = { type: 'play', playerIndex: 1, cardIndex: 0, chosenColor: 'green' };
  var g3 = E.applyPlay(g2, action, seededRng(9));
  assertEqual(N.message(g3, N.playNote(g2, action)), 'CPU 1 plays wild +4, choosing green. Challenge the Wild Draw Four, or take 4?');
  var g4 = E.applyChallenge(g3, seededRng(9));
  assertEqual(N.message(g4, N.challengeCall(0)),
    'You challenge the Wild Draw Four. Challenge failed: CPU 1 had no red to play. You draw 6.');
  assertEqual(N.message(makeGame([FILLER[0], FILLER[1]], card('red', '5')), ''), '');
});

test('the narration of a CPU taking a stack never says it drew a card', function () {
  /* The wording ui.js used to show when a CPU ate a whole stack. */
  var checked = 0;
  for (var seed = 700; seed < 730; seed++) {
    var rng = seededRng(seed);
    var s = E.createGame({ numPlayers: 2 + (seed % 3), stackDraws: true, challengeRule: seed % 2 === 0 }, rng);
    for (var i = 0; i < 3000 && s.phase === 'playing'; i++) {
      var plays = E.legalPlays(s, s.currentPlayer);
      if (s.pendingChallenge && rng() < 0.3) { s = E.applyChallenge(s, rng); continue; }
      if (plays.length && rng() < 0.7) {
        var p = plays[0];
        s = E.applyPlay(s, { type: 'play', playerIndex: s.currentPlayer, cardIndex: p.cardIndex,
          chosenColor: E.isWild(p.card) ? 'red' : undefined, declareUno: true }, rng);
        continue;
      }
      if (s.pendingDraw) { s = E.applyPass(s); continue; }
      var next = E.applyDraw(s, rng);
      var note = N.drawNote(s, next);
      if (N.owed(s) > 0) {
        checked++;
        assertEqual(/takes? \d+/.test(note), true, 'seed ' + seed + ': ' + note);
        assertEqual(/a card/.test(note), false, 'seed ' + seed + ': ' + note);
      }
      s = next;
    }
  }
  assertEqual(checked > 100, true, 'enough takes to mean something: ' + checked);
});

run();
