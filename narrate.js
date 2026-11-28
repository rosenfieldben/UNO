/*
 * narrate.js
 *
 * The words the message bar shows, as pure functions of engine states.
 * ui.js decides when to say something; this decides what, so the text
 * can be tested under node against real transitions instead of living
 * as string fragments next to DOM calls. Nothing here touches the DOM,
 * holds state, or changes a state it is handed.
 *
 * Everything is read off the engine's own record of what happened (the
 * states before and after a move, unoPenalty, challengeResult) rather
 * than off what the UI meant to do. The engine is the only thing that
 * knows how many cards a draw really dealt, which is not always what
 * was owed when the piles run dry.
 *
 * Same classic-script wrapper as the rest, so it loads from a file://
 * URL as window.UnoNarrate and under node via require(). It needs the
 * engine: under node it requires it, and in the browser engine.js must
 * load first, which index.html does.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'));
  } else {
    root.UnoNarrate = factory(root.UnoEngine);
  }
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  var VALUE_LABEL = {
    skip: '⊘', reverse: '⇄', draw2: '+2', wild: 'WILD', wild4: '+4'
  };

  /* The names a sentence uses for the cards that can answer a stack. */
  var VALUE_NAME = { draw2: 'Draw Two', wild4: 'Wild Draw Four' };

  function cardLabel(card) { return VALUE_LABEL[card.value] || card.value; }

  function playerName(i) { return i === 0 ? 'You' : 'CPU ' + i; }

  /* "You draw" but "CPU 1 draws": the human is always addressed as you. */
  function verb(seat, base) { return seat === 0 ? base : base + 's'; }

  /*
   * The total the player on turn must answer or take, or 0. Inside a
   * challenge window that is the Wild Draw Four's four; under the
   * stacking house rule it is whatever has piled up. Without stacking a
   * total only ever exists inside a window, since a Draw Two or an
   * accepted Wild Draw Four deals its cards at once.
   */
  function owed(state) {
    if (state.phase !== 'playing') return 0;
    if (state.pendingChallenge) return state.pendingDrawCount;
    return state.config.stackDraws ? state.pendingDrawCount : 0;
  }

  /*
   * What the human owes, as the question the message bar asks, or '' when
   * nothing is owed. Answering is offered only when the engine would
   * accept it, so the sentence never names a move that would be refused:
   * inside a window that needs stacking and a Wild Draw Four in hand, and
   * no answer is possible to an offender who played their last card.
   */
  function prompt(state) {
    var total = owed(state);
    if (!total || state.currentPlayer !== 0) return '';
    var canAnswer = E.legalPlays(state, 0).length > 0;
    var card = VALUE_NAME[state.pendingDrawValue];
    /*
     * The question can stand alone, on a reload or after a blocked tap,
     * so it names the card rather than saying "it".
     */
    if (state.pendingChallenge) {
      return canAnswer
        ? 'Challenge the Wild Draw Four, answer with your own, or take ' + total + '?'
        : 'Challenge the Wild Draw Four, or take ' + total + '?';
    }
    return canAnswer
      ? 'Answer with a ' + card + ', or take ' + total + '?'
      : 'You have no ' + card + ' to answer with: take ' + total + '.';
  }

  /*
   * Why a tap did nothing, for a card that cannot be played or the draw
   * pile. When a total is owed both point at the same decision, because
   * taking it is a choice with its own button rather than a stray tap on
   * the pile.
   */
  function blockedNote(state, target) {
    var question = prompt(state);
    if (question) return question;
    if (state.pendingDraw) {
      return target === 'pile'
        ? 'You already drew: play the card or keep it.'
        : 'Only the drawn card can be played now.';
    }
    return "That card doesn't match.";
  }

  function playNote(state, action) {
    var seat = action.playerIndex;
    var card = state.players[seat].hand[action.cardIndex];
    return playerName(seat) + ' ' + verb(seat, 'play') + ' ' + (card.color || 'wild') + ' ' + cardLabel(card) +
      (action.chosenColor ? ', choosing ' + action.chosenColor : '') +
      (action.declareUno ? '. UNO!' : '.');
  }

  /*
   * One applyDraw, told from the states either side of it. Taking a total
   * and drawing a single card are the same engine action, and telling
   * them apart is the whole point: a player who takes eight has not
   * "drawn a card". The count is what the hand actually gained, less any
   * Uno penalty the same move dealt to the same player, which the message
   * reports separately.
   */
  function drawNote(before, after) {
    var seat = before.currentPlayer;
    var name = playerName(seat);
    var penalty = after.unoPenalty && after.unoPenalty.player === seat ? after.unoPenalty.drew : 0;
    var drew = after.players[seat].hand.length - before.players[seat].hand.length - penalty;
    var total = owed(before);
    if (total) {
      return name + ' ' + verb(seat, 'take') + ' ' + (drew < total ? drew + ' of ' + total + '; the piles ran out.' : total + '.');
    }
    if (drew === 0) {
      return seat === 0 ? 'No cards left to draw; turn passes.' : name + ' has nothing left to draw.';
    }
    if (seat !== 0) return name + ' draws a card.';
    return after.pendingDraw ? 'You drew a playable card: play it or keep it.' : 'You draw a card; turn passes.';
  }

  function challengeCall(seat) {
    return seat === 0 ? 'You challenge the Wild Draw Four.' : playerName(seat) + ' challenges the Wild Draw Four!';
  }

  /*
   * A successful challenge is an accusation, so the message carries the
   * evidence with it: how many cards of the color in play the offender
   * was holding when the wild went down. That count comes from the
   * engine's snapshot, which is the only honest source for it.
   */
  function challengeNote(result) {
    var offender = playerName(result.offender);
    if (result.guilty) {
      return 'Challenge upheld: ' + offender + ' held ' + result.colorMatches + ' ' +
        result.color + ' card' + (result.colorMatches === 1 ? '' : 's') + ' and ' +
        verb(result.offender, 'draw') + ' ' + result.drew + '.';
    }
    var basis = result.color === null
      ? 'there was no color in play to match'
      : offender + ' held no ' + result.color;
    return 'Challenge failed: ' + basis + '. ' + playerName(result.challenger) + ' ' +
      verb(result.challenger, 'draw') + ' ' + result.drew + '.';
  }

  function penaltyNote(penalty) {
    return playerName(penalty.player) + ' missed UNO and ' + verb(penalty.player, 'draw') + ' ' + penalty.drew + '!';
  }

  /*
   * The whole message after a move: any automatic Uno penalty the move
   * dealt, the move itself, the verdict if it was a challenge, and what
   * the human owes next, if anything. Each part comes from the engine's
   * record of the transition, never from hand sizes compared by eye.
   */
  function message(next, note) {
    var parts = [];
    if (next.unoPenalty && next.unoPenalty.drew > 0) parts.push(penaltyNote(next.unoPenalty));
    if (note) parts.push(note);
    if (next.challengeResult) parts.push(challengeNote(next.challengeResult));
    var question = prompt(next);
    if (question) parts.push(question);
    return parts.join(' ');
  }

  return {
    cardLabel: cardLabel,
    playerName: playerName,
    owed: owed,
    prompt: prompt,
    blockedNote: blockedNote,
    playNote: playNote,
    drawNote: drawNote,
    challengeCall: challengeCall,
    challengeNote: challengeNote,
    penaltyNote: penaltyNote,
    message: message
  };
});
