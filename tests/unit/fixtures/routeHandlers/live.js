'use strict';

// A route handler module whose exports a test replaces, for routeBuilder's
// read-on-every-call test.
let calls = 0;

module.exports = {
  answer: (req, res) => res.json({ answered: 'live' }),
  counted: (req, res) => { calls += 1; return res.json({ calls }); },
  calls: () => calls,
  resetCalls: () => { calls = 0; },
};
