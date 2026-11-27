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
   *
   * avoidColor exists for bluffs. An honest Wild Draw Four almost never
   * re-declares the color already in play, because the player holds none
   * of it; a bluffer holding plenty would. Declaring it would announce
   * the bluff to the whole table, so a bluff picks the best other color.
   */
  function bestColor(hand, excludeIndex, avoidColor) {
    var counts = { red: 0, yellow: 0, green: 0, blue: 0 };
    hand.forEach(function (card, i) {
      if (i !== excludeIndex && card.color) counts[card.color] += 1;
    });
    var best = null;
    E.COLORS.forEach(function (color) {
      if (color === avoidColor) return;
      if (best === null || counts[color] > counts[best]) best = color;
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
   * Whether to bluff with a Wild Draw Four this turn. The chance comes
   * from config and the roll from the injected rng, the same way the Uno
   * forget chance works. A chance of 0 draws nothing from the rng, so a
   * game without bluffing consumes randomness exactly as it did before
   * bluffing existed and seeded games replay unchanged.
   */
  function decideBluff(state, rng) {
    var chance = state.config.cpuBluffChance;
    return chance > 0 && rng() < chance;
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

  function makePlay(state, playerIndex, pick, rng, avoidColor) {
    var hand = state.players[playerIndex].hand;
    var action = {
      type: 'play',
      playerIndex: playerIndex,
      cardIndex: pick.cardIndex,
      declareUno: decideUnoCall(state, hand, rng)
    };
    if (E.isWild(pick.card)) {
      action.chosenColor = bestColor(hand, pick.cardIndex, avoidColor);
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
   *      with a legal Draw Two or Wild Draw Four, sometimes bluffing
   *      the Wild Draw Four (see below).
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
      /* Prefer spending the cheap Draw Two before the Wild Draw Four. */
      var draw2 = null, wild4 = null, hasOther = false;
      plays.forEach(function (p) {
        if (p.card.value === 'draw2' && !draw2) draw2 = p;
        if (p.card.value === 'wild4') { if (!wild4) wild4 = p; } else hasOther = true;
      });
      if (draw2) return makePlay(state, playerIndex, draw2, rng);
      /*
       * With the challenge rule on, a Wild Draw Four played while holding
       * the color in play is a bluff: legal, but a challenge would catch
       * it. A CPU that never bluffs makes every challenge an almost sure
       * loss, so here it bluffs with probability cpuBluffChance.
       *
       * Only here, against an opponent about to go out. When this was
       * tuned, a scratch version (not committed) that also bluffed in
       * ordinary play lost 2 to 3 points of round win rate in
       * bench-bluff.js at chance 0.2, because it spends the Wild Draw
       * Four long before it matters. Bluffing only here, at the default
       * chance, costs about a tenth of a point of round win rate at most
       * against the same seeds played without it: the bench's win-rate
       * pass at 60,000 rounds per table size measured 0.04, 0.09 and
       * 0.12 points at two, three and four players, and only the
       * four-player interval excludes zero. The price is a tell, by
       * deliberate choice: a Wild Draw Four played at someone holding
       * three or more cards is never a chosen bluff.
       *
       * The roll happens only when it decides something: the Wild Draw
       * Four would be a bluff and another legal play exists. With the
       * rule off nothing is a bluff and nothing is rolled, so play there
       * is exactly as before. A Wild Draw Four that is the only legal
       * card is not a bluff decision either. Answering a stack it cannot
       * be a bluff, since an answer is never judged on color (see
       * applyCardEffect in engine.js); on an ordinary turn it is the only
       * legal card only when no card of the color in play is held, which
       * makes it honest. Declining is always safe, since it only happens
       * when another legal play exists.
       */
      if (wild4) {
        var wouldBluff = state.config.challengeRule && holdsActiveColor(state, playerIndex);
        if (!wouldBluff) return makePlay(state, playerIndex, wild4, rng);
        if (hasOther && decideBluff(state, rng)) {
          return makePlay(state, playerIndex, wild4, rng, state.currentColor);
        }
      }
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
