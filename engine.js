/*
 * engine.js
 *
 * Pure Uno rules engine. No DOM access, no globals, no hidden state.
 * Every exported function takes a plain state object and returns a new
 * one (callers keep the old state untouched), and all randomness flows
 * through an injected rng() returning a float in [0, 1) so that games
 * and tests are fully deterministic under a seeded rng.
 *
 * The file uses a classic-script wrapper instead of ES modules because
 * the game must run from a file:// URL, where browsers refuse to load
 * module scripts. Under node it exports via module.exports; in the
 * browser it attaches to window.UnoEngine.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.UnoEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COLORS = ['red', 'yellow', 'green', 'blue'];

  /*
   * Cards are tiny plain objects: { color, value }. Wilds carry a null
   * color because their effective color is whatever the player declares,
   * which lives in state.currentColor rather than on the card. That keeps
   * the discard pile an honest record of the physical cards.
   */
  function buildDeck() {
    var deck = [];
    COLORS.forEach(function (color) {
      deck.push({ color: color, value: '0' });
      for (var n = 1; n <= 9; n++) {
        deck.push({ color: color, value: String(n) });
        deck.push({ color: color, value: String(n) });
      }
      ['skip', 'reverse', 'draw2'].forEach(function (v) {
        deck.push({ color: color, value: v });
        deck.push({ color: color, value: v });
      });
    });
    for (var i = 0; i < 4; i++) {
      deck.push({ color: null, value: 'wild' });
      deck.push({ color: null, value: 'wild4' });
    }
    return deck;
  }

  /* Fisher-Yates on a copy; the input array is never mutated. */
  function shuffle(cards, rng) {
    var arr = cards.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /*
   * State is pure JSON (no functions, no dates, no cycles), so a simple
   * recursive copy is enough. Cloning at each transition is what lets the
   * public functions behave as pure state -> state maps.
   */
  function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') {
      var out = {};
      for (var k in value) {
        if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = clone(value[k]);
      }
      return out;
    }
    return value;
  }

  function isWild(card) {
    return card.value === 'wild' || card.value === 'wild4';
  }

  function cardPoints(card) {
    if (isWild(card)) return 50;
    if (card.value === 'skip' || card.value === 'reverse' || card.value === 'draw2') return 20;
    return parseInt(card.value, 10);
  }

  function handPoints(hand) {
    return hand.reduce(function (sum, card) { return sum + cardPoints(card); }, 0);
  }

  function topDiscard(state) {
    return state.discardPile[state.discardPile.length - 1];
  }

  /* Seat `steps` places away from `from`, following the current direction. */
  function playerAfter(state, from, steps) {
    var n = state.config.numPlayers;
    return ((from + state.direction * steps) % n + n) % n;
  }

  function advance(state, steps) {
    state.currentPlayer = playerAfter(state, state.currentPlayer, steps);
  }

  /*
   * A play is legal if it matches the top discard by color, number, or
   * symbol, or is a Wild. Wild Draw Four is treated as always playable;
   * the official challenge rule (playing it only with no color match, and
   * the next player being allowed to challenge) is deliberately not
   * implemented, matching most casual play.
   *
   * Color matching is checked against state.currentColor rather than the
   * printed color of the top card, because after a Wild the declared
   * color is the one that counts. A null currentColor means the round
   * opened on a flipped Wild: the first player picks the color simply by
   * playing anything, so every card matches.
   */
  function matchesTop(state, card) {
    if (isWild(card)) return true;
    if (state.currentColor === null) return true;
    if (card.color === state.currentColor) return true;
    return card.value === topDiscard(state).value;
  }

  function legalPlays(state, playerIndex) {
    if (state.phase !== 'playing' || playerIndex !== state.currentPlayer) return [];
    var hand = state.players[playerIndex].hand;

    /*
     * After drawing a playable card the player may play only that card;
     * the rest of the hand is locked for the remainder of the turn.
     */
    if (state.pendingDraw) {
      var idx = state.pendingDraw.cardIndex;
      return [{ cardIndex: idx, card: hand[idx] }];
    }

    /*
     * Stacking house rule (off by default): while a draw total is
     * pending, only a card of the same value may be played, pushing the
     * accumulated penalty on to the next player.
     */
    if (state.config.stackDraws && state.pendingDrawCount > 0) {
      var stacks = [];
      hand.forEach(function (card, i) {
        if (card.value === state.pendingDrawValue) stacks.push({ cardIndex: i, card: card });
      });
      return stacks;
    }

    var plays = [];
    hand.forEach(function (card, i) {
      if (matchesTop(state, card)) plays.push({ cardIndex: i, card: card });
    });
    return plays;
  }

  /*
   * Refill the draw pile from the discard pile, keeping the top discard
   * in place so play can continue against it. If the discard pile has
   * only its top card there is nothing to recycle: nearly every card is
   * in someone's hand, and draws simply come up empty until cards return
   * to the piles. That is rare but must not crash.
   */
  function refillDrawPile(state, rng) {
    if (state.discardPile.length <= 1) return;
    var top = state.discardPile.pop();
    state.drawPile = shuffle(state.discardPile, rng);
    state.discardPile = [top];
  }

  function drawCards(state, playerIndex, count, rng) {
    var player = state.players[playerIndex];
    for (var k = 0; k < count; k++) {
      if (state.drawPile.length === 0) refillDrawPile(state, rng);
      if (state.drawPile.length === 0) break;
      player.hand.push(state.drawPile.pop());
    }
    /* Any growth of the hand ends a standing "Uno!" declaration. */
    if (player.hand.length !== 1) player.calledUno = false;
  }

  /*
   * Uno enforcement. state.unoPending marks a player who reached one card
   * without declaring; the window closes on the next action, whoever
   * takes it, and the two-card penalty lands automatically. The penalty
   * is applied lazily here (at the start of that next action) rather
   * than eagerly, because the offender is allowed to call Uno at any
   * moment inside the window.
   *
   * The offender themself acting again first (a two-player game where a
   * Skip, Reverse, Draw Two, or Wild Draw Four hands the turn straight
   * back) closes the window WITH the penalty. Letting it close for free
   * would make those cards a legal way to play out a forgotten Uno: the
   * skipped opponent never takes an engine turn, so nothing else could
   * ever trigger enforcement. The offender's whole between-actions gap
   * was their chance to call.
   */
  function enforceUnoPenalty(state, rng) {
    if (state.unoPending === null) return;
    var offender = state.unoPending;
    var before = state.players[offender].hand.length;
    drawCards(state, offender, 2, rng);
    /*
     * The penalty is recorded on the state so the UI can narrate it as
     * a fact. Inferring it from hand-size changes misfires: a penalized
     * player may also draw voluntarily in the same action. drew is the
     * number of cards actually taken, which can fall short of two when
     * the piles are exhausted.
     */
    state.unoPenalty = { player: offender, drew: state.players[offender].hand.length - before };
    state.unoPending = null;
  }

  /*
   * Applies the consequence of an action card just played. The player who
   * played it is still state.currentPlayer, so "next player" is one seat
   * ahead and advancing two seats implements "loses their turn".
   */
  function applyCardEffect(state, card, rng) {
    switch (card.value) {
      case 'skip':
        advance(state, 2);
        break;
      case 'reverse':
        if (state.config.numPlayers === 2) {
          /*
           * With two players Reverse acts as Skip: the opponent is
           * skipped and the same player leads again. Direction is left
           * alone because it carries no information in a two-seat loop.
           */
          advance(state, 2);
        } else {
          state.direction *= -1;
          advance(state, 1);
        }
        break;
      case 'draw2':
        forceDraw(state, 2, 'draw2', rng);
        break;
      case 'wild4':
        forceDraw(state, 4, 'wild4', rng);
        break;
      default:
        advance(state, 1);
    }
  }

  function forceDraw(state, amount, value, rng) {
    if (state.config.stackDraws) {
      /*
       * Under the stacking house rule the penalty is not resolved yet:
       * the next player may answer with the same card. The total only
       * lands when someone finally draws (see applyDraw).
       */
      state.pendingDrawCount += amount;
      state.pendingDrawValue = value;
      advance(state, 1);
    } else {
      drawCards(state, playerAfter(state, state.currentPlayer, 1), amount, rng);
      advance(state, 2);
    }
  }

  function endRound(state, rng) {
    /*
     * A round can end while a stacked draw total is still unresolved:
     * under the stacking house rule the winning card (a Draw Two or
     * Wild Draw Four, or an answer to a stack) only deferred its amount
     * into pendingDrawCount. The official rule that makes a final Draw
     * Two land before scoring applies to the accumulated total as well,
     * so the player on turn, who would have answered the stack, eats it
     * here before hands are counted. This keeps the stacking and
     * non-stacking modes consistent on how a round may end.
     */
    if (state.pendingDrawCount > 0) {
      drawCards(state, state.currentPlayer, state.pendingDrawCount, rng);
    }
    var winner = -1;
    state.players.forEach(function (p, i) {
      if (p.hand.length === 0) winner = i;
    });
    /*
     * Standard scoring: the round winner collects the value of every card
     * left in the opponents' hands.
     */
    var points = 0;
    state.players.forEach(function (p, i) {
      if (i !== winner) points += handPoints(p.hand);
    });
    state.players[winner].score += points;
    state.roundWinner = winner;
    state.roundPoints = points;
    state.unoPending = null;
    state.pendingDraw = null;
    state.pendingDrawCount = 0;
    state.pendingDrawValue = null;
    if (state.players[winner].score >= state.config.targetScore) {
      state.phase = 'gameOver';
      state.gameWinner = winner;
    } else {
      state.phase = 'roundOver';
    }
  }

  /*
   * Deals a fresh round into an existing state (scores persist across
   * rounds). presetDeck is a test hook: when provided, it is used verbatim
   * instead of a shuffled deck, with the END of the array being the top of
   * the draw pile (cards are drawn with pop()).
   */
  function startRound(state, rng, presetDeck) {
    state.round += 1;
    state.phase = 'playing';
    state.direction = 1;
    state.currentPlayer = 0;
    state.unoPending = null;
    state.unoPenalty = null;
    state.pendingDraw = null;
    state.pendingDrawCount = 0;
    state.pendingDrawValue = null;
    state.roundWinner = null;
    state.roundPoints = 0;
    state.gameWinner = null;
    state.discardPile = [];
    state.players.forEach(function (p) {
      p.hand = [];
      p.calledUno = false;
    });
    state.drawPile = presetDeck ? presetDeck.slice() : shuffle(buildDeck(), rng);

    for (var c = 0; c < 7; c++) {
      for (var p = 0; p < state.config.numPlayers; p++) {
        state.players[p].hand.push(state.drawPile.pop());
      }
    }

    var first = state.drawPile.pop();
    /*
     * A Wild Draw Four may never start the discard pile: it goes back in
     * and the draw pile is reshuffled until something else turns up. The
     * retries are bounded because the honest procedure only terminates
     * probabilistically: a rigged preset deck with nothing but Wild Draw
     * Fours left, or a degenerate injected rng that keeps shuffling one
     * back on top, would spin this loop forever. A real deck reaches the
     * fallback with odds far below one in a billion, and pulling the
     * first other card from an already-shuffled pile is indistinguishable
     * from one more lucky re-flip.
     */
    var reflips = 0;
    while (first.value === 'wild4' && reflips < 8) {
      reflips += 1;
      state.drawPile.push(first);
      state.drawPile = shuffle(state.drawPile, rng);
      first = state.drawPile.pop();
    }
    if (first.value === 'wild4') {
      state.drawPile.push(first);
      var swap = -1;
      for (var s = 0; s < state.drawPile.length; s++) {
        if (state.drawPile[s].value !== 'wild4') { swap = s; break; }
      }
      if (swap === -1) {
        throw new Error('cannot start a round: only Wild Draw Fours left to flip');
      }
      first = state.drawPile.splice(swap, 1)[0];
    }
    state.discardPile.push(first);
    state.currentColor = first.color;

    /*
     * An action card flipped first applies its effect to the player who
     * would have led. Rather than re-implementing each effect here,
     * pretend a virtual dealer in the last seat played the card: every
     * effect in applyCardEffect is expressed relative to the player who
     * played it, which makes seat 0 the dealer's "next player". That
     * keeps the first-flip rules, including the stacking house rule for
     * a flipped Draw Two, in the one place they are defined.
     *
     * The exception is Reverse with three or more players: official play
     * hands the dealer the lead, but with no real dealer seat here seat 0
     * keeps the lead and only the direction flips, so play proceeds
     * toward the last seat. With two players the dealer trick applies as
     * usual and the flipped Reverse acts as a Skip.
     */
    if (first.value === 'reverse' && state.config.numPlayers > 2) {
      state.direction = -1;
    } else {
      state.currentPlayer = state.config.numPlayers - 1;
      applyCardEffect(state, first, rng);
    }
    /*
     * A flipped plain Wild leaves currentColor null, which matchesTop
     * treats as "anything goes": the first player picks the color simply
     * by playing a card. Through applyCardEffect it just advances the
     * virtual dealer's turn to seat 0, like any number card.
     */
  }

  function createGame(config, rng) {
    config = config || {};
    var numPlayers = config.numPlayers != null ? config.numPlayers : 2;
    if (numPlayers < 2 || numPlayers > 4) {
      throw new Error('numPlayers must be between 2 and 4');
    }
    var state = {
      config: {
        numPlayers: numPlayers,
        targetScore: config.targetScore != null ? config.targetScore : 500,
        /*
         * House rule, off by default: answering a Draw Two or Wild Draw
         * Four with the same card pushes the accumulated total onward.
         */
        stackDraws: !!config.stackDraws,
        /*
         * Consumed by the AI layer when deciding whether to declare Uno;
         * kept in config so one object describes the whole game and the
         * human gets a chance to catch forgetful CPUs.
         */
        cpuForgetUnoChance: config.cpuForgetUnoChance != null ? config.cpuForgetUnoChance : 0.2
      },
      players: [],
      round: 0,
      phase: 'playing',
      direction: 1,
      currentPlayer: 0,
      currentColor: null,
      drawPile: [],
      discardPile: [],
      unoPending: null,
      /*
       * Transient: describes the Uno penalty applied by the most recent
       * transition, or null. Cleared at the start of every action so a
       * state never carries a stale penalty report forward.
       */
      unoPenalty: null,
      pendingDraw: null,
      pendingDrawCount: 0,
      pendingDrawValue: null,
      roundWinner: null,
      roundPoints: 0,
      gameWinner: null
    };
    for (var i = 0; i < numPlayers; i++) {
      state.players.push({
        hand: [],
        score: 0,
        calledUno: false,
        /* Seat 0 is the human by convention; the engine itself is agnostic. */
        isHuman: i === 0
      });
    }
    startRound(state, rng, config._deck);
    return state;
  }

  function startNextRound(state, rng) {
    if (state.phase !== 'roundOver') throw new Error('no round to start: phase is ' + state.phase);
    var next = clone(state);
    startRound(next, rng);
    return next;
  }

  /*
   * action: { type: 'play', playerIndex, cardIndex, chosenColor?, declareUno? }
   * declareUno lets a player shout "Uno!" in the same motion as playing
   * their second-to-last card, which is how it works at a real table.
   */
  function applyPlay(state, action, rng) {
    rng = rng || Math.random;
    if (state.phase !== 'playing') throw new Error('round is over');
    if (!action || action.type !== 'play') throw new Error('applyPlay needs a play action');
    if (action.playerIndex !== state.currentPlayer) {
      throw new Error('player ' + action.playerIndex + ' acted out of turn');
    }
    var legal = legalPlays(state, action.playerIndex);
    var allowed = legal.some(function (p) { return p.cardIndex === action.cardIndex; });
    if (!allowed) throw new Error('illegal play: card index ' + action.cardIndex);

    var card = state.players[action.playerIndex].hand[action.cardIndex];
    if (isWild(card) && COLORS.indexOf(action.chosenColor) === -1) {
      throw new Error('a Wild must declare a color');
    }

    var next = clone(state);
    next.unoPenalty = null;
    enforceUnoPenalty(next, rng);

    var player = next.players[action.playerIndex];
    var played = player.hand.splice(action.cardIndex, 1)[0];
    next.discardPile.push(played);
    next.currentColor = isWild(played) ? action.chosenColor : played.color;
    next.pendingDraw = null;

    player.calledUno = false;
    if (player.hand.length === 1) {
      if (action.declareUno) {
        player.calledUno = true;
      } else {
        next.unoPending = action.playerIndex;
      }
    }

    applyCardEffect(next, played, rng);

    /*
     * The win check happens after the card effect on purpose: a final
     * Draw Two or Wild Draw Four still makes the next player draw before
     * the round is scored, per the official rules.
     */
    if (player.hand.length === 0) endRound(next, rng);
    return next;
  }

  /*
   * The current player draws one card. If the drawn card is playable it is
   * NOT auto-played: state.pendingDraw records it and the player chooses
   * between applyPlay (that card only) and applyPass. If it is not
   * playable the turn passes immediately, since the player has no choice
   * to make.
   */
  function applyDraw(state, rng) {
    rng = rng || Math.random;
    if (state.phase !== 'playing') throw new Error('round is over');
    if (state.pendingDraw) throw new Error('already drew this turn: play the card or pass');

    var next = clone(state);
    next.unoPenalty = null;
    var pi = next.currentPlayer;
    enforceUnoPenalty(next, rng);
    var player = next.players[pi];

    if (next.config.stackDraws && next.pendingDrawCount > 0) {
      /* Declining (or being unable) to stack means eating the whole total. */
      drawCards(next, pi, next.pendingDrawCount, rng);
      next.pendingDrawCount = 0;
      next.pendingDrawValue = null;
      advance(next, 1);
      return next;
    }

    var before = player.hand.length;
    drawCards(next, pi, 1, rng);
    if (player.hand.length === before) {
      /* Both piles are effectively empty; the turn just passes. */
      advance(next, 1);
      return next;
    }
    var idx = player.hand.length - 1;
    if (matchesTop(next, player.hand[idx])) {
      next.pendingDraw = { cardIndex: idx };
    } else {
      advance(next, 1);
    }
    return next;
  }

  /* Decline to play a just-drawn playable card; only valid in that window. */
  function applyPass(state) {
    if (state.phase !== 'playing') throw new Error('round is over');
    if (!state.pendingDraw) throw new Error('pass is only allowed after drawing a playable card');
    var next = clone(state);
    next.unoPenalty = null;
    next.pendingDraw = null;
    advance(next, 1);
    return next;
  }

  /* Declare Uno inside the vulnerability window, before anyone else acts. */
  function callUno(state, playerIndex) {
    if (state.unoPending !== playerIndex) {
      throw new Error('no Uno call pending for player ' + playerIndex);
    }
    var next = clone(state);
    next.unoPenalty = null;
    next.unoPending = null;
    next.players[playerIndex].calledUno = true;
    return next;
  }

  /*
   * Catch a player who reached one card without declaring. This applies
   * the same two-card penalty that would land automatically when the next
   * player acts; exposing it lets the human pounce on a forgetful CPU.
   */
  function catchUno(state, rng) {
    rng = rng || Math.random;
    if (state.unoPending === null) throw new Error('nobody forgot to call Uno');
    var next = clone(state);
    var offender = next.unoPending;
    var before = next.players[offender].hand.length;
    drawCards(next, offender, 2, rng);
    /* Same penalty record as the automatic path, so the UI narrates both alike. */
    next.unoPenalty = { player: offender, drew: next.players[offender].hand.length - before };
    next.unoPending = null;
    return next;
  }

  /*
   * Structural validator: returns a list of problems (empty means valid).
   * The key invariant is conservation: the union of all hands and both
   * piles must be exactly the 108-card deck, which catches duplication or
   * loss bugs in any transition.
   */
  function validateState(state) {
    var errors = [];
    if (!state || !state.config) return ['state or config missing'];
    var n = state.config.numPlayers;
    if (state.players.length !== n) errors.push('player count mismatch');
    if (state.direction !== 1 && state.direction !== -1) errors.push('bad direction');
    if (state.currentPlayer < 0 || state.currentPlayer >= n) errors.push('currentPlayer out of range');
    if (['playing', 'roundOver', 'gameOver'].indexOf(state.phase) === -1) errors.push('bad phase');
    if (state.currentColor !== null && COLORS.indexOf(state.currentColor) === -1) {
      errors.push('bad currentColor');
    }
    if (state.phase === 'playing' && state.discardPile.length === 0) {
      errors.push('empty discard pile during play');
    }
    if (state.unoPending !== null && (state.unoPending < 0 || state.unoPending >= n)) {
      errors.push('unoPending out of range');
    }

    var tally = {};
    function key(card) { return (card.color || 'wild') + ':' + card.value; }
    function count(card) { tally[key(card)] = (tally[key(card)] || 0) + 1; }
    state.players.forEach(function (p) { p.hand.forEach(count); });
    state.drawPile.forEach(count);
    state.discardPile.forEach(count);
    var expected = {};
    buildDeck().forEach(function (card) {
      expected[key(card)] = (expected[key(card)] || 0) + 1;
    });
    Object.keys(expected).forEach(function (k) {
      if (tally[k] !== expected[k]) {
        errors.push('card count for ' + k + ': expected ' + expected[k] + ', found ' + (tally[k] || 0));
      }
    });
    Object.keys(tally).forEach(function (k) {
      if (!expected[k]) errors.push('unknown card ' + k);
    });
    return errors;
  }

  return {
    COLORS: COLORS,
    buildDeck: buildDeck,
    shuffle: shuffle,
    isWild: isWild,
    cardPoints: cardPoints,
    handPoints: handPoints,
    topDiscard: topDiscard,
    playerAfter: playerAfter,
    matchesTop: matchesTop,
    createGame: createGame,
    startNextRound: startNextRound,
    legalPlays: legalPlays,
    applyPlay: applyPlay,
    applyDraw: applyDraw,
    applyPass: applyPass,
    callUno: callUno,
    catchUno: catchUno,
    validateState: validateState
  };
});
