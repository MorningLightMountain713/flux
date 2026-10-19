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
 * at that height; the library refuses it on any other chain.
 *
 * @returns {import('@runonflux/flux-spec').Chain}
 * @throws {Error} for a chain name the library has no parameters for, or a
 *   v9 height set on a chain that follows its own rule heights
 */
function nodeChain() {
  const name = config.get('daemon.chain');
  const v9Height = config.get('daemon.harnessV9ActivationHeight');
  if (built && built.name === name && built.v9Height === v9Height) return built.chain;
  const { Chain, V9_ACTIVATION } = loaded();
  const named = Chain.named(name);
  const chain = v9Height === null ? named : named.withActivations([[V9_ACTIVATION, v9Height]]);
  built = { name, v9Height, chain };
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
 * The height each spec version is accepted from on this node's chain.
 * @returns {Object<number, number>}
 */
function specActivationHeights() {
  return { ...config.get('fluxapps.appSpecsEnforcementHeights'), 9: v9ActivationHeight() };
}

module.exports = { nodeChain, v9ActivationHeight, specActivationHeights };
