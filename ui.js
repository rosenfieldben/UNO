/*
 * ui.js
 *
 * The only layer allowed to touch the DOM. It holds the current game
 * state and mutates it exclusively through engine functions (plus the
 * AI's chooseAction for CPU seats), then re-renders everything from the
 * state, so the screen can never drift from the rules.
 */
(function () {
  'use strict';

  var E = window.UnoEngine;
  var AI = window.UnoAI;
  var rng = Math.random;

  /* Long enough to follow CPU turns and to click Catch on a forgetful CPU. */
  var CPU_DELAY = 1000;

  var state = null;
  var cpuTimer = null;
  var pendingWildIndex = null;
  /* True when the human pressed UNO! before playing their second-to-last card. */
  var unoArmed = false;

  function $(id) { return document.getElementById(id); }

  var VALUE_LABEL = {
    skip: '⊘', reverse: '⇄', draw2: '+2', wild: 'WILD', wild4: '+4'
  };

  function label(card) { return VALUE_LABEL[card.value] || card.value; }

  function playerName(i) { return i === 0 ? 'You' : 'CPU ' + i; }

  function setMessage(text) { $('message-bar').textContent = text; }

  /* ----- state transitions ----- */

  /*
   * Every change funnels through here: adopt the new state, narrate any
   * automatic Uno penalty the transition caused, then re-render and let
   * the CPU loop continue.
   */
  function commit(next, note) {
    /*
     * Uno penalties are narrated from the engine's own record rather
     * than inferred from hand-size changes, which used to misreport a
     * pending player's voluntary draw as a two-card penalty and missed
     * real penalties whenever the same move re-armed the Uno window.
     */
    if (next.unoPenalty && next.unoPenalty.drew > 0) {
      var offender = next.unoPenalty.player;
      note = playerName(offender) + ' missed UNO and ' + (offender === 0 ? 'draw ' : 'draws ') +
        next.unoPenalty.drew + '! ' + (note || '');
    }
    state = next;
    if (state.currentPlayer !== 0 || state.players[0].hand.length !== 2) unoArmed = false;
    /* Always written, so a successful action clears stale error text. */
    setMessage((note || '').trim());
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
    var action = AI.chooseAction(state, seat, rng);
    if (action.type === 'draw') {
      commit(E.applyDraw(state, rng), playerName(seat) + ' draws a card.');
      return;
    }
    var card = state.players[seat].hand[action.cardIndex];
    var note = playerName(seat) + ' plays ' + (card.color || 'wild') + ' ' + label(card) +
      (action.chosenColor ? ', choosing ' + action.chosenColor : '') +
      (action.declareUno ? '. UNO!' : '.');
    commit(E.applyPlay(state, action, rng), note);
  }

  /* ----- human actions ----- */

  function humanPlay(cardIndex, chosenColor) {
    var card = state.players[0].hand[cardIndex];
    var note = 'You play ' + (card.color || 'wild') + ' ' + label(card) +
      (chosenColor ? ', choosing ' + chosenColor : '') + (unoArmed ? '. UNO!' : '.');
    var action = {
      type: 'play', playerIndex: 0, cardIndex: cardIndex,
      chosenColor: chosenColor, declareUno: unoArmed
    };
    try {
      commit(E.applyPlay(state, action, rng), note);
    } catch (err) {
      setMessage(err.message);
    }
  }

  function onCardClick(cardIndex) {
    if (state.phase !== 'playing' || state.currentPlayer !== 0) return;
    var legal = E.legalPlays(state, 0).some(function (p) { return p.cardIndex === cardIndex; });
    if (!legal) {
      setMessage(state.pendingDraw ? 'Only the drawn card can be played now.' : "That card doesn't match.");
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
    if (state.pendingDraw) { setMessage('You already drew: play the card or keep it.'); return; }
    var before = state.players[0].hand.length;
    var next = E.applyDraw(state, rng);
    var note = next.players[0].hand.length === before
      ? 'No cards left to draw; turn passes.'
      : (next.pendingDraw ? 'You drew a playable card: play it or keep it.' : 'You draw a card; turn passes.');
    commit(next, note);
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
    state = null;
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
    state = E.createGame({ numPlayers: opponents + 1, targetScore: target }, rng);
    unoArmed = false;
    setMessage(state.currentPlayer === 0 ? 'Your move.' : playerName(state.currentPlayer) + ' starts.');
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
})();
