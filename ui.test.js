/*
 * ui.test.js
 *
 * Wiring tests for ui.js. Save and resume: Start Game saves, a move
 * saves, a reload resumes, New game clears. Stacking: the setup box
 * reaches the engine, a total the human owes is shown with a Take
 * button, only that button takes it, and a CPU taking a stack is
 * narrated as a take. The decisions themselves are tested elsewhere
 * (what to save in save.test.js, the words in narrate.test.js); this
 * only checks that ui.js calls them where it must.
 *
 * ui.js expects a browser, so it runs here inside node's built-in vm
 * against a hand-rolled fake page that implements just the DOM calls
 * ui.js makes. It is not a DOM: anything rendered is accepted and
 * dropped, apart from the class lists and child counts the asserts
 * read. Math.random is seeded, so the deal and every draw are the same
 * on every run. CPU timers are held rather than run, and a test that
 * needs a CPU move runs the latest one by hand. Zero dependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var E = require('./engine.js');
var AI = require('./ai.js');
var S = require('./save.js');
var N = require('./narrate.js');
var U = require('./testutil.js');

var test = U.test, run = U.run;
var assert = U.assert, assertEqual = U.assertEqual;
var memoryStorage = U.memoryStorage;

var UI_SOURCE = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');

/* ----- fake page ----- */

function fakeElement() {
  var classes = {}, listeners = [];
  var el = {
    children: [],
    classList: {
      add: function (c) { classes[c] = true; },
      remove: function (c) { delete classes[c]; },
      contains: function (c) { return !!classes[c]; },
      toggle: function (c, on) { if (on === undefined ? !classes[c] : on) classes[c] = true; else delete classes[c]; }
    },
    appendChild: function (child) { el.children.push(child); return child; },
    addEventListener: function (type, fn) { if (type === 'click') listeners.push(fn); },
    click: function () { listeners.forEach(function (fn) { fn(); }); }
  };
  /* ui.js clears a container by assigning its text, as the DOM does. */
  var text = '';
  Object.defineProperty(el, 'textContent', {
    get: function () { return text; },
    set: function (v) { text = String(v); el.children = []; }
  });
  return el;
}

/*
 * Loads ui.js into a fresh page sharing the given storage, as a reload
 * does. Returns the page's getElementById, with runCpu attached to it:
 * it runs the CPU move ui.js last scheduled, if any.
 */
function openPage(storage, seed) {
  var byId = {};
  var timer = null;
  var document = {
    getElementById: function (id) { return byId[id] || (byId[id] = fakeElement()); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: function () { return fakeElement(); }
  };
  vm.runInNewContext(UI_SOURCE, {
    window: { UnoEngine: E, UnoAI: AI, UnoSave: S, UnoNarrate: N, localStorage: storage },
    document: document,
    Math: Object.assign(Object.create(Math), { random: U.seededRng(seed) }),
    setTimeout: function (fn) { timer = fn; return 1; },
    clearTimeout: function () { timer = null; }
  });
  var el = document.getElementById;
  el.runCpu = function () { var fn = timer; timer = null; if (fn) fn(); };
  return el;
}

/* ----- helpers ----- */

function savedState(storage) {
  return S.decode(storage.items[S.KEY]);
}

/* Starts a game on a fresh page; under seed 3 the human leads. */
function startedPage(storage) {
  var el = openPage(storage, 3);
  el('start-button').click();
  return el;
}

/* One real move through commit(): the human draws a card. */
function move(el, storage) {
  assertEqual(savedState(storage).currentPlayer, 0, 'the human is on turn');
  el('draw-pile').click();
}

/* ----- tests ----- */

test('Start Game saves the new game', function () {
  var storage = memoryStorage();
  startedPage(storage);
  var saved = savedState(storage);
  assert(saved !== null, 'a valid save exists');
  assertEqual(saved.phase, 'playing');
  assertEqual(saved.round, 1);
});

test('a move saves the new state', function () {
  var storage = memoryStorage();
  var el = startedPage(storage);
  var before = storage.items[S.KEY];
  move(el, storage);
  var after = storage.items[S.KEY];
  assert(after !== before, 'the save changed');
  assert(S.decode(after) !== null, 'and is still a valid save');
});

test('a reload resumes the saved game', function () {
  var storage = memoryStorage();
  move(startedPage(storage), storage);
  var before = storage.items[S.KEY];
  var reloaded = openPage(storage, 99);
  assert(reloaded('setup-screen').classList.contains('hidden'), 'setup is hidden');
  assert(!reloaded('game-screen').classList.contains('hidden'), 'the game is shown');
  assert(/^Welcome back\./.test(reloaded('message-bar').textContent), 'greets the player');
  assertEqual(reloaded('human-hand').children.length, savedState(storage).players[0].hand.length,
    'the saved hand is on screen');
  assertEqual(storage.items[S.KEY], before, 'resuming changes nothing');
});

test('New game clears the save', function () {
  var storage = memoryStorage();
  var el = startedPage(storage);
  move(el, storage);
  assert(S.KEY in storage.items, 'precondition: a save exists');
  el('quit-button').click();
  assert(!(S.KEY in storage.items), 'save removed');
  assert(!el('setup-screen').classList.contains('hidden'), 'back on setup');
});

/*
 * A saved two-player game with stacking on, opened on a fresh page: the
 * flipped Draw Two leaves the human, who leads, owing two.
 */
function facingStack(storage, hand0) {
  var g = U.makeGame([hand0, U.FILLER[1]], U.card('red', 'draw2'), { stackDraws: true });
  S.persist(storage, g);
  return openPage(storage, 5);
}

test('Start Game passes the stacking box to the engine', function () {
  var off = memoryStorage();
  startedPage(off);
  assertEqual(savedState(off).config.stackDraws, false, 'unticked, as before stacking was offered');
  var on = memoryStorage();
  var el = openPage(on, 3);
  el('stack-draws').checked = true;
  el('start-button').click();
  assertEqual(savedState(on).config.stackDraws, true, 'ticked');
});

test('a total the human owes is shown, with Take, and the pile does not take it', function () {
  var storage = memoryStorage();
  var el = facingStack(storage, U.FILLER[0]);
  assert(!el('pending-total').classList.contains('hidden'), 'the total is on the table');
  assertEqual(el('pending-total').textContent, '+2');
  assert(!el('accept-button').classList.contains('hidden'), 'Take is offered');
  assertEqual(el('accept-button').textContent, 'Take 2');
  assert(el('challenge-button').classList.contains('hidden'), 'a stack is not a challenge');
  assertEqual(el('message-bar').textContent, 'Welcome back. You have no Draw Two to answer with: take 2.');

  var before = storage.items[S.KEY];
  el('draw-pile').click();
  assertEqual(storage.items[S.KEY], before, 'a tap on the pile changes nothing');
  assertEqual(el('message-bar').textContent, 'You have no Draw Two to answer with: take 2.');

  el('accept-button').click();
  var saved = savedState(storage);
  assertEqual(saved.players[0].hand.length, 9, 'Take dealt the two');
  assertEqual(saved.currentPlayer, 1);
  assertEqual(el('message-bar').textContent, 'You take 2.');
  assert(el('pending-total').classList.contains('hidden'), 'nothing is pending now');
  assert(el('accept-button').classList.contains('hidden'));
});

test('answering a stack passes it on, and a CPU that takes it is narrated as a take', function () {
  var storage = memoryStorage();
  var el = facingStack(storage, [U.card('green', 'draw2')].concat(U.FILLER[0].slice(0, 6)));
  assertEqual(el('message-bar').textContent, 'Welcome back. Answer with a Draw Two, or take 2?');
  el('human-hand').children[0].click();
  assertEqual(el('message-bar').textContent, 'You play green +2.');
  assertEqual(el('pending-total').textContent, '+4', 'the total grew and waits on CPU 1');
  assert(el('accept-button').classList.contains('hidden'), 'Take is the human\'s button only');

  el.runCpu();
  var saved = savedState(storage);
  assertEqual(saved.players[1].hand.length, 11, 'CPU 1 had no Draw Two and took all four');
  assertEqual(el('message-bar').textContent, 'CPU 1 takes 4.');
});

run();
