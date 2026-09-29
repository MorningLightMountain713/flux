'use strict';

// A route handler module that counts its own loads, for routeBuilder's
// first-call loading test.
global.routeBuilderFixtureLoads = (global.routeBuilderFixtureLoads || 0) + 1;

module.exports = {
  answer: (req, res) => res.json({ answered: 'counted' }),
  reject: async () => { throw new Error('handler failed'); },
};
