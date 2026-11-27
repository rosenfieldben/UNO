/*
 * ui.js
 *
 * The only layer allowed to touch the DOM. It holds the current game
 * state and mutates it exclusively through engine functions (plus the
 * AI's chooseAction for CPU seats), then re-renders everything from the
 * state, so the screen can never drift from the rules. The one other
 * way in is a game restored by save.js, which validates it first. Every
 * state the UI adopts is handed back to save.js, so a reload resumes it.
 * The words in the message bar come from narrate.js, which reads them
 * off the engine states; this file only decides when to show them.
 */
(function () {
  'use strict';

  var E = window.UnoEngine;
  var AI = window.UnoAI;
  var S = window.UnoSave;
  var N = window.UnoNarrate;
  var rng = Math.random;
  /* null when storage is missing or blocked; save.js then does nothing. */
  var storage = S.storageFrom(window);

  /* Long enough to follow CPU turns and to click Catch on a forgetful CPU. */
  var CPU_DELAY = 1000;

  var state = null;
  var cpuTimer = null;
  var pendingWildIndex = null;
  /* True when the human pressed UNO! before playing their second-to-last card. */
  var unoArmed = false;

  function $(id) { return document.getElementById(id); }

  var label = N.cardLabel;
  var playerName = N.playerName;

  function setMessage(text) { $('message-bar').textContent = text; }

  /* True when the human is on turn owing a total: a Wild Draw Four or a stack. */
  function humanOwes() {
    return !!(state && state.currentPlayer === 0 && N.owed(state) > 0);
  }

  /* ----- state transitions ----- */

  /*
   * The only place the game state is replaced, and it saves in the same
   * step: null clears the save, and so does a finished game (see
   * persist in save.js). Keeping the two together means no path can take
   * on a state without saving it, or leave the screen and the save
   * disagreeing. Saving every state, CPU moves included, is what lets a
   * reload resume the latest move rather than an older one.
   */
  function adopt(next) {
    state = next;
    S.persist(storage, next);
  }

  /*
   * Every move funnels through here: adopt the new state, show the move
   * along with whatever else the transition did (see message in
   * narrate.js), then re-render and let the CPU loop continue.
   */
  function commit(next, note) {
    adopt(next);
    if (state.currentPlayer !== 0 || state.players[0].hand.length !== 2) unoArmed = false;
    /* Always written, so a successful action clears stale error text. */
    setMessage(N.message(next, note));
    render();
    scheduleCpu();
  }

  function scheduleCpu() {
    clearTimeout(cpuTimer);
    if (!state) return;
    if (state.phase !== 'playing') { showSummary(); return; }
    if (state.currentPlayer === 0) return;
    cpuTimer = setTimeout(cpuStep, CPU_DELAY);
  }

  function cpuStep() {
    if (!state || state.phase !== 'playing' || state.currentPlayer === 0) return;
    var seat = state.currentPlayer;
    if (state.pendingChallenge && state.pendingChallenge.victim === seat) {
      if (AI.decideChallenge(state, seat, rng)) {
        commit(E.applyChallenge(state, rng), N.challengeCall(seat));
        return;
      }
      /*
       * Declining is not the end of it under the stacking house rule:
       * chooseAction below finds an answering Wild Draw Four as an
       * ordinary play, and otherwise falls back to drawing, which is
       * exactly the accept.
       */
    }
    var action = AI.chooseAction(state, seat, rng);
    if (action.type === 'draw') {
      var drawn = E.applyDraw(state, rng);
      commit(drawn, N.drawNote(state, drawn));
      return;
    }
    commit(E.applyPlay(state, action, rng), N.playNote(state, action));
  }

  /* ----- human actions ----- */

  function humanPlay(cardIndex, chosenColor) {
    var action = {
      type: 'play', playerIndex: 0, cardIndex: cardIndex,
      chosenColor: chosenColor, declareUno: unoArmed
    };
    try {
      commit(E.applyPlay(state, action, rng), N.playNote(state, action));
    } catch (err) {
      setMessage(err.message);
    }
  }

  /*
   * Challenge, and Take for any total the human owes: a Wild Draw Four
   * under the challenge rule, or a stack under the stacking rule. Both
   * are ordinary engine actions; the buttons exist so the choice is
   * explicit, the way the keep / play-drawn pair works for a just-drawn
   * card. Answering a stack needs no button of its own: it is a card
   * played from the hand like any other.
   */
  function onChallengeClick() {
    if (!state || !state.pendingChallenge || state.pendingChallenge.victim !== 0) return;
    commit(E.applyChallenge(state, rng), N.challengeCall(0));
  }

  function onTakeClick() {
    if (!humanOwes()) return;
    var taken = E.applyDraw(state, rng);
    commit(taken, N.drawNote(state, taken));
  }

  function onCardClick(cardIndex) {
    if (state.phase !== 'playing' || state.currentPlayer !== 0) return;
    var legal = E.legalPlays(state, 0).some(function (p) { return p.cardIndex === cardIndex; });
    if (!legal) {
      setMessage(N.blockedNote(state, 'card'));
      return;
    }
    if (E.isWild(state.players[0].hand[cardIndex])) {
      pendingWildIndex = cardIndex;
      $('color-modal').classList.remove('hidden');
      return;
    }
    humanPlay(cardIndex, undefined);
  }

  function onDrawClick() {
    if (!state || state.phase !== 'playing' || state.currentPlayer !== 0) return;
    /*
     * Taking a total is a decision, so it goes through its own button
     * rather than a stray tap on the pile: the engine would deal the
     * whole stack for that tap, not one card.
     */
    if (state.pendingDraw || humanOwes()) {
      setMessage(N.blockedNote(state, 'pile'));
      return;
    }
    var next = E.applyDraw(state, rng);
    commit(next, N.drawNote(state, next));
  }

  function onUnoClick() {
    if (!state) return;
    if (state.unoPending === 0) {
      commit(E.callUno(state, 0), 'UNO!');
      return;
    }
    if (state.phase === 'playing' && state.currentPlayer === 0 && state.players[0].hand.length === 2) {
      unoArmed = !unoArmed;
      render();
    }
  }

  function onCatchClick() {
    if (!state || state.unoPending === null || state.unoPending === 0) return;
    var caught = state.unoPending;
    /* commit() narrates the penalty itself; this note adds only the who. */
    commit(E.catchUno(state, rng), 'You caught ' + playerName(caught) + '!');
  }

  /* ----- rendering ----- */

  function cardNode(card, extraClass) {
    var el = document.createElement('div');
    el.className = 'card ' + (E.isWild(card) ? 'wildcard' : card.color) + (extraClass || '');
    var corner = document.createElement('span');
    corner.className = 'corner';
    corner.textContent = label(card);
    var value = document.createElement('span');
    value.className = 'value';
    value.textContent = label(card);
    el.appendChild(corner);
    el.appendChild(value);
    return el;
  }

  function render() {
    if (!state) return;

    /* Opponents */
    var row = $('opponents-row');
    row.textContent = '';
    for (var i = 1; i < state.config.numPlayers; i++) {
      var p = state.players[i];
      var box = document.createElement('div');
      box.className = 'opponent' + (state.phase === 'playing' && state.currentPlayer === i ? ' current-turn' : '');

      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = playerName(i);
      var score = document.createElement('span');
      score.className = 'score';
      score.textContent = p.score + ' pts';
      name.appendChild(score);
      if (p.calledUno) {
        var badge = document.createElement('span');
        badge.className = 'uno-badge';
        badge.textContent = 'UNO!';
        name.appendChild(badge);
      } else if (state.unoPending === i) {
        var missed = document.createElement('span');
        missed.className = 'uno-badge missed';
        missed.textContent = 'forgot?';
        name.appendChild(missed);
      }
      box.appendChild(name);

      var fan = document.createElement('div');
      fan.className = 'fan';
      for (var c = 0; c < Math.min(p.hand.length, 10); c++) {
        var back = document.createElement('div');
        back.className = 'card back small';
        fan.appendChild(back);
      }
      box.appendChild(fan);

      var count = document.createElement('div');
      count.className = 'count';
      count.textContent = p.hand.length + (p.hand.length === 1 ? ' card' : ' cards');
      box.appendChild(count);
      row.appendChild(box);
    }

    /* Table center */
    $('draw-count').textContent = state.drawPile.length + ' left';
    var discard = $('discard-pile');
    discard.textContent = '';
    discard.appendChild(cardNode(E.topDiscard(state)));
    $('color-indicator').className = state.currentColor || 'none';
    $('color-indicator').title = 'Current color: ' + (state.currentColor || 'any');
    $('direction-indicator').textContent =
      state.config.numPlayers === 2 ? '' : (state.direction === 1 ? '↻' : '↺');
    /*
     * The total waiting on the player to move, whoever that is, so a
     * stack can be watched growing before it reaches the human.
     */
    var total = N.owed(state);
    var pending = $('pending-total');
    pending.classList.toggle('hidden', total === 0);
    pending.textContent = total ? '+' + total : '';
    pending.title = total
      ? total + ' cards waiting for ' + (state.currentPlayer === 0 ? 'you' : playerName(state.currentPlayer))
      : '';

    /* Human hand */
    $('human-area').classList.toggle('current-turn',
      state.phase === 'playing' && state.currentPlayer === 0);
    $('human-score').textContent = state.players[0].score + ' pts' +
      (state.players[0].calledUno ? '  UNO!' : '');

    var handEl = $('human-hand');
    handEl.textContent = '';
    var legal = {};
    E.legalPlays(state, 0).forEach(function (p) { legal[p.cardIndex] = true; });
    state.players[0].hand.forEach(function (card, idx) {
      var extra = '';
      if (state.currentPlayer === 0 && state.phase === 'playing' && legal[idx]) extra += ' playable';
      if (state.pendingDraw && state.currentPlayer === 0 && state.pendingDraw.cardIndex === idx) {
        extra += ' just-drawn';
      }
      var el = cardNode(card, extra);
      el.addEventListener('click', onCardClick.bind(null, idx));
      handEl.appendChild(el);
    });

    /* Buttons */
    var unoBtn = $('uno-button');
    var showUno = state.unoPending === 0 ||
      (state.phase === 'playing' && state.currentPlayer === 0 && state.players[0].hand.length === 2);
    unoBtn.classList.toggle('hidden', !showUno);
    unoBtn.classList.toggle('armed', unoArmed);
    unoBtn.textContent = unoArmed ? 'UNO armed' : 'UNO!';

    $('catch-button').classList.toggle('hidden', !(state.unoPending !== null && state.unoPending !== 0));

    var facingWild4 = !!(state.phase === 'playing' && state.pendingChallenge &&
      state.pendingChallenge.victim === 0);
    $('challenge-button').classList.toggle('hidden', !facingWild4);
    var takeBtn = $('accept-button');
    takeBtn.classList.toggle('hidden', !humanOwes());
    /* Four for a Wild Draw Four; a stack can be any total. */
    if (humanOwes()) takeBtn.textContent = 'Take ' + N.owed(state);

    var drewPlayable = !!(state.pendingDraw && state.currentPlayer === 0 && state.phase === 'playing');
    $('play-drawn-button').classList.toggle('hidden', !drewPlayable);
    $('keep-button').classList.toggle('hidden', !drewPlayable);
  }

  /* ----- round and game summary ----- */

  function showSummary() {
    var over = state.phase === 'gameOver';
    var winner = over ? state.gameWinner : state.roundWinner;
    $('summary-title').textContent = over
      ? playerName(winner) + (winner === 0 ? ' win the game!' : ' wins the game!')
      : playerName(winner) + (winner === 0 ? ' win the round!' : ' wins the round!');
    $('summary-detail').textContent = '+' + state.roundPoints + ' points from cards left in other hands. ' +
      (over ? '' : 'Playing to ' + state.config.targetScore + '.');

    var table = $('summary-scores');
    table.textContent = '';
    var head = document.createElement('tr');
    ['Player', 'Score'].forEach(function (h) {
      var th = document.createElement('th');
      th.textContent = h;
      head.appendChild(th);
    });
    table.appendChild(head);
    state.players.forEach(function (p, i) {
      var tr = document.createElement('tr');
      if (i === winner) tr.className = 'winner';
      var name = document.createElement('td');
      name.textContent = playerName(i);
      var score = document.createElement('td');
      score.textContent = p.score;
      tr.appendChild(name);
      tr.appendChild(score);
      table.appendChild(tr);
    });

    $('summary-button').textContent = over ? 'Play again' : 'Next round';
    $('summary-modal').classList.remove('hidden');
  }

  function onSummaryClick() {
    $('summary-modal').classList.add('hidden');
    if (state.phase === 'gameOver') {
      backToSetup();
    } else {
      commit(E.startNextRound(state, rng), 'Round ' + (state.round + 1) + ' begins.');
    }
  }

  /* ----- screens ----- */

  function backToSetup() {
    clearTimeout(cpuTimer);
    /*
     * Both ways here end the game for good, New game and Play again, so
     * adopting null also clears the save and a reload cannot bring it
     * back.
     */
    adopt(null);
    $('game-screen').classList.add('hidden');
    $('summary-modal').classList.add('hidden');
    $('color-modal').classList.add('hidden');
    $('setup-screen').classList.remove('hidden');
  }

  function startGame() {
    var opponents = 2;
    var selected = document.querySelector('#opponent-choices .selected');
    if (selected) opponents = parseInt(selected.dataset.count, 10);
    var target = parseInt($('target-score').value, 10);
    if (!(target > 0)) target = 500;

    $('setup-screen').classList.add('hidden');
    $('game-screen').classList.remove('hidden');
    adopt(E.createGame({
      numPlayers: opponents + 1,
      targetScore: target,
      challengeRule: $('challenge-rule').checked,
      stackDraws: $('stack-draws').checked
    }, rng));
    unoArmed = false;
    /* A flipped Draw Two under stacking leaves the human owing it at once. */
    setMessage(state.currentPlayer === 0
      ? (N.prompt(state) || 'Your move.')
      : playerName(state.currentPlayer) + ' starts.');
    render();
    scheduleCpu();
  }

  /*
   * Picks up a saved game where it stopped. A save that is missing, from
   * another version, or fails validation loads as null, and the setup
   * screen shows as if nothing had been saved. The UI-only state starts
   * fresh: an armed Uno call or a half-chosen Wild color is not part of
   * the save. Narration attached to the saved state (unoPenalty,
   * challengeResult) is not replayed, since it describes a move the
   * player already saw.
   */
  function resumeSavedGame() {
    var saved = S.load(storage);
    if (!saved) return;
    /* Saving it again is harmless: it writes back the same state. */
    adopt(saved);
    unoArmed = false;
    pendingWildIndex = null;
    $('setup-screen').classList.add('hidden');
    $('game-screen').classList.remove('hidden');
    var turn = '';
    if (state.phase === 'playing') {
      turn = state.currentPlayer === 0
        ? ' ' + (N.prompt(state) || 'Your move.')
        : ' ' + playerName(state.currentPlayer) + ' to play.';
    }
    setMessage('Welcome back.' + turn);
    render();
    scheduleCpu();
  }

  /* ----- wire up ----- */

  document.querySelectorAll('#opponent-choices .choice').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('#opponent-choices .choice').forEach(function (b) {
        b.classList.remove('selected');
      });
      btn.classList.add('selected');
    });
  });

  $('start-button').addEventListener('click', startGame);
  $('draw-pile').addEventListener('click', onDrawClick);
  $('uno-button').addEventListener('click', onUnoClick);
  $('catch-button').addEventListener('click', onCatchClick);
  $('challenge-button').addEventListener('click', onChallengeClick);
  $('accept-button').addEventListener('click', onTakeClick);
  $('keep-button').addEventListener('click', function () {
    if (state && state.pendingDraw && state.currentPlayer === 0) {
      commit(E.applyPass(state), 'You keep the card; turn passes.');
    }
  });
  $('play-drawn-button').addEventListener('click', function () {
    if (state && state.pendingDraw && state.currentPlayer === 0) {
      onCardClick(state.pendingDraw.cardIndex);
    }
  });
  $('quit-button').addEventListener('click', backToSetup);
  $('summary-button').addEventListener('click', onSummaryClick);

  document.querySelectorAll('.color-pick').forEach(function (btn) {
    btn.addEventListener('click', function () {
      $('color-modal').classList.add('hidden');
      if (pendingWildIndex !== null) {
        var idx = pendingWildIndex;
        pendingWildIndex = null;
        humanPlay(idx, btn.dataset.color);
      }
    });
  });

  resumeSavedGame();
})();
