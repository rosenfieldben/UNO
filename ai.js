/*
 * ai.js
 *
 * CPU opponent for the Uno engine. chooseAction is a pure function of
 * (state, playerIndex, rng): it never mutates state and its only source
 * of randomness is the injected rng, so a seeded rng makes every CPU
 * decision reproducible.
 *
 * Same classic-script wrapper as the engine so it loads from file:// in
 * the browser (window.UnoAI) and via require() under node. Under node
 * the engine is required directly; in the browser it is expected to be
 * loaded first as window.UnoEngine.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'));
  } else {
    root.UnoAI = factory(root.UnoEngine);
  }
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  function colorCounts(hand) {
    var counts = { red: 0, yellow: 0, green: 0, blue: 0 };
    hand.forEach(function (card) {
      if (card.color) counts[card.color] += 1;
    });
    return counts;
  }

  /*
   * The declared color for a Wild is the color the hand is longest in,
   * because that maximizes the chance of having a follow-up play. Ties
   * break in fixed COLORS order so the choice stays deterministic.
   */
  function bestColor(hand, excludeIndex) {
    var counts = { red: 0, yellow: 0, green: 0, blue: 0 };
    hand.forEach(function (card, i) {
      if (i !== excludeIndex && card.color) counts[card.color] += 1;
    });
    var best = E.COLORS[0];
    E.COLORS.forEach(function (color) {
      if (counts[color] > counts[best]) best = color;
    });
    return best;
  }

  /*
   * Whether to shout "Uno!" when about to drop to one card. The forget
   * chance comes from config and flows through the injected rng, so the
   * human gets deterministic-under-seed opportunities to catch a CPU.
   */
  function decideUnoCall(state, hand, rng) {
    if (hand.length !== 2) return false;
    return rng() >= state.config.cpuForgetUnoChance;
  }

  /*
   * Whether the victim of a Wild Draw Four challenges it, as a pure
   * function of (state, playerIndex, rng) like every other decision here.
   *
   * It reads only what a player at a real table can see: its own hand,
   * the other hands' SIZES, the discard pile, and the color that was
   * active before the wild. Reading the offender's cards would let the
   * CPU challenge exactly when it is right, which is not something a
   * human can play against, so the blindness is the point rather than an
   * oversight.
   */
  function decideChallenge(state, playerIndex, rng) {
    var pending = state.pendingChallenge;
    if (!pending || pending.victim !== playerIndex) return false;
    var offender = state.players[pending.offender];
    /*
     * The offender went out on it, which makes a challenge a guaranteed
     * loss. openChallenge freezes guilt on the hand left AFTER the played
     * card is removed, and an emptied hand cannot hold the active color,
     * so a last-card Wild Draw Four always snapshots zero matches and is
     * innocent by construction. Challenging it draws the total plus two
     * instead of the total, in a round that ends either way, and those
     * extra cards score against the challenger. Declining is strictly
     * better in every case, so it is unconditional rather than a
     * threshold below.
     *
     * Only a rigged state can make an empty hand guilty (cards moved out
     * of it mid-window by a test helper). No legal transition reaches
     * one: while the window is open cards can enter a hand, never leave
     * it.
     */
    if (offender.hand.length === 0) return false;
    /* No active color to dodge means the play was legal by definition. */
    if (pending.color === null) return false;

    var chance = 0.25;
    /* A big hand is likelier to still hold the color it claimed not to. */
    if (offender.hand.length >= 5) chance += 0.15;
    if (offender.hand.length >= 8) chance += 0.1;
    /*
     * Cards of that color already face up are cards the offender cannot
     * be holding, so the more of them, the likelier the play was honest.
     */
    var seen = 0;
    state.discardPile.forEach(function (c) {
      if (c.color === pending.color) seen += 1;
    });
    chance -= Math.min(seen, 8) * 0.02;
    if (chance < 0.05) chance = 0.05;
    return rng() < chance;
  }

  /*
   * Whether the hand still holds the color that is currently in play,
   * which is exactly what makes a Wild Draw Four challengeable.
   */
  function holdsActiveColor(state, playerIndex) {
    if (state.currentColor === null) return false;
    return state.players[playerIndex].hand.some(function (c) {
      return c.color === state.currentColor;
    });
  }

  function makePlay(state, playerIndex, pick, rng) {
    var hand = state.players[playerIndex].hand;
    var action = {
      type: 'play',
      playerIndex: playerIndex,
      cardIndex: pick.cardIndex,
      declareUno: decideUnoCall(state, hand, rng)
    };
    if (E.isWild(pick.card)) {
      action.chosenColor = bestColor(hand, pick.cardIndex);
    }
    return action;
  }

  /*
   * Returns a legal action for the given player:
   *   { type: 'play', ... }  or  { type: 'draw' }
   * (never 'pass': a CPU that draws a playable card always plays it,
   * which chooseAction covers via the engine's pendingDraw window).
   *
   * Strategy, in priority order:
   *   1. If the next opponent is down to two or fewer cards, hit them
   *      with a legal Draw Two or Wild Draw Four.
   *   2. Otherwise play a non-wild card, preferring the color the hand
   *      holds most of; Wilds are held back as long as any other play
   *      exists, since they are legal on anything and only gain value.
   *   3. With no legal play at all, draw.
   */
  function chooseAction(state, playerIndex, rng) {
    if (state.phase !== 'playing' || playerIndex !== state.currentPlayer) {
      throw new Error('chooseAction called out of turn');
    }
    var plays = E.legalPlays(state, playerIndex);
    if (plays.length === 0) return { type: 'draw' };

    /* A just-drawn playable card is the only option; take it. */
    if (state.pendingDraw) {
      return makePlay(state, playerIndex, plays[0], rng);
    }

    var hand = state.players[playerIndex].hand;
    var nextOpponent = state.players[E.playerAfter(state, playerIndex, 1)];

    if (nextOpponent.hand.length <= 2) {
      /*
       * Prefer spending the cheap Draw Two before the Wild Draw Four.
       * With the challenge rule on, a Wild Draw Four played while
       * holding the active color can be sent straight back, and the CPU
       * cannot see whether the victim will call it: drawing four to hand
       * out four is a bad trade, and the card keeps its value for a turn
       * when the play is honest. Skipping it here can never strand the
       * CPU, since a card of the active color is a legal play by color.
       */
      var bluffs = state.config.challengeRule && holdsActiveColor(state, playerIndex);
      var punish = null;
      plays.forEach(function (p) {
        if (p.card.value === 'draw2' && (!punish || punish.card.value !== 'draw2')) punish = p;
        if (p.card.value === 'wild4' && !punish && !bluffs) punish = p;
      });
      if (punish) return makePlay(state, playerIndex, punish, rng);
    }

    var nonWild = plays.filter(function (p) { return !E.isWild(p.card); });
    if (nonWild.length) {
      /*
       * Rank by how many cards of that color remain in hand, so future
       * turns keep having plays; among equals, shed the most expensive
       * card first to limit round-loss points. Both criteria and the
       * final index tiebreak are deterministic.
       */
      var counts = colorCounts(hand);
      nonWild.sort(function (a, b) {
        var byColor = counts[b.card.color] - counts[a.card.color];
        if (byColor !== 0) return byColor;
        var byPoints = E.cardPoints(b.card) - E.cardPoints(a.card);
        if (byPoints !== 0) return byPoints;
        return a.cardIndex - b.cardIndex;
      });
      return makePlay(state, playerIndex, nonWild[0], rng);
    }

    /* Only Wilds are legal; spend the plain Wild before the Draw Four. */
    var wild = null;
    plays.forEach(function (p) {
      if (p.card.value === 'wild' && !wild) wild = p;
    });
    return makePlay(state, playerIndex, wild || plays[0], rng);
  }

  return {
    chooseAction: chooseAction,
    decideChallenge: decideChallenge,
    bestColor: bestColor
  };
});
