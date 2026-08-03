// The sessions this node currently owns.
//
// Its own module because two unrelated subsystems have to agree on it and
// neither should have to import the other. playgroundService writes it;
// appJanitor reads it, because both of its sweeps would otherwise destroy a live
// session. The orphan sweep removes containers with no installed-app row and the
// debris sweep removes app networks no installed app owns - a playground session
// is precisely both of those things on purpose, so "no installed row" cannot be
// the whole test for debris while sessions exist.
//
// In memory, and that is the durability model, not an omission: a session is one
// process's 15-minute arrangement with one caller. A restart ends every session
// it was running, which is exactly why the reaper treats every labelled
// container it cannot account for as abandoned.

// What marks a container as a session's. It lives here rather than beside the
// code that applies it because the modules that need to RECOGNISE a session
// container - appJanitor, containerEventBridge - must not have to import
// playgroundRunner, which reaches dockerService and fluxNetworkHelper.
const PLAYGROUND_LABEL = 'flux.playground';

const sessions = new Map();

function add(session) {
  sessions.set(session.sessionId, session);
}

function remove(sessionId) {
  return sessions.delete(sessionId);
}

function get(sessionId) {
  return sessions.get(sessionId) ?? null;
}

function size() {
  return sessions.size;
}

function all() {
  return [...sessions.values()];
}

/** The ids the reaper accounts for; anything labelled otherwise is abandoned. */
function liveIds() {
  return new Set(sessions.keys());
}

function reset() {
  sessions.clear();
}

module.exports = {
  PLAYGROUND_LABEL,
  add,
  remove,
  get,
  size,
  all,
  liveIds,
  reset,
};
