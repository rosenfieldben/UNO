/*
 * ui.test.js
 *
 * Wiring test for save and resume in ui.js: Start Game saves, a move
 * saves, a reload resumes, New game clears. The decisions themselves
 * (what to save, clear, or reject) are tested in save.test.js; this
 * only checks that ui.js calls them where it must.
 *
 * ui.js expects a browser, so it runs here inside node's built-in vm
 * against a hand-rolled fake page that implements just the DOM calls
 * ui.js makes. It is not a DOM: anything rendered is accepted and
 * dropped, apart from the class lists and child counts the asserts
 * read. Math.random is seeded, so the deal and every draw are the same
 * on every run. CPU timers are swallowed: a CPU move goes through the
 * same commit() as the human's, so one human move covers the wiring.
 * Zero dependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var E = require('./engine.js');
var AI = require('./ai.js');
var S = require('./save.js');
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

/* Loads ui.js into a fresh page sharing the given storage, as a reload does. */
function openPage(storage, seed) {
  var byId = {};
  var document = {
    getElementById: function (id) { return byId[id] || (byId[id] = fakeElement()); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: function () { return fakeElement(); }
  };
  vm.runInNewContext(UI_SOURCE, {
    window: { UnoEngine: E, UnoAI: AI, UnoSave: S, localStorage: storage },
    document: document,
    Math: Object.assign(Object.create(Math), { random: U.seededRng(seed) }),
    setTimeout: function () { return 0; },
    clearTimeout: function () {}
  });
  return document.getElementById;
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

run();
