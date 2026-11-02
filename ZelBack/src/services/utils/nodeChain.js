'use strict';

const config = require('config');
const { loaded } = require('./specLibrary');

let built = null;

/**
 * The chain this node runs on, as the flux-spec library defines it: named by
 * `daemon.chain`, fluxd's own name for it. Every spec this node builds from a
 * document is read on it, and boot refuses a daemon reporting another.
 *
 * `daemon.harnessV9ActivationHeight` starts the harness chain with v9's rules
 * at that height, and `daemon.harnessQuorumGrantActivationHeight` with the
 * grant plane at that one; the library refuses either on any other chain, and
 * a plane height below v9's.
 *
 * @returns {import('@runonflux/flux-spec').Chain}
 * @throws {Error} for a chain name the library has no parameters for, a
 *   height set on a chain that follows its own rule heights, or a plane height
 *   below v9's
 */
function nodeChain() {
  const name = config.get('daemon.chain');
  const v9Height = config.get('daemon.harnessV9ActivationHeight');
  const planeHeight = config.get('daemon.harnessQuorumGrantActivationHeight');
  if (built && built.name === name && built.v9Height === v9Height && built.planeHeight === planeHeight) return built.chain;
  const { Chain, V9_ACTIVATION, QUORUM_GRANT_ACTIVATION } = loaded();
  const named = Chain.named(name);
  const started = [[V9_ACTIVATION, v9Height], [QUORUM_GRANT_ACTIVATION, planeHeight]].filter(([, height]) => height !== null);
  const chain = started.length === 0 ? named : named.withActivations(started);
  QUORUM_GRANT_ACTIVATION.heightOn(chain);
  built = { name, v9Height, planeHeight, chain };
  return chain;
}

/**
 * The height every v9 rule starts at on this node's chain.
 * @returns {number}
 */
function v9ActivationHeight() {
  return loaded().V9_ACTIVATION.heightOn(nodeChain());
}

/**
 * The height the grant plane starts governing at on this node's chain, or null
 * while it is not scheduled there. Never below v9's.
 * @returns {?number}
 */
function quorumGrantActivationHeight() {
  return loaded().QUORUM_GRANT_ACTIVATION.heightOn(nodeChain());
}

/**
 * The height each spec version is accepted from on this node's chain.
 * @returns {Object<number, number>}
 */
function specActivationHeights() {
  return { ...config.get('fluxapps.appSpecsEnforcementHeights'), 9: v9ActivationHeight() };
}

module.exports = {
  nodeChain, v9ActivationHeight, quorumGrantActivationHeight, specActivationHeights,
};
