'use strict';

const config = require('config');
const { loaded } = require('./specLibrary');

/**
 * The chain this node runs on, as the flux-spec library defines it: named by
 * `daemon.chain`, fluxd's own name for it. Every spec this node builds from a
 * document is read on it, and boot refuses a daemon reporting another.
 *
 * @returns {import('@runonflux/flux-spec').Chain}
 * @throws {Error} for a chain name the library has no parameters for
 */
function nodeChain() {
  return loaded().Chain.named(config.get('daemon.chain'));
}

module.exports = { nodeChain };
