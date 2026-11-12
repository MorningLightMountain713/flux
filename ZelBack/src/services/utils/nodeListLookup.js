'use strict';

const { normalizeSocketAddress } = require('./socketAddressUtils');

// A node is its collateral; the address it is listed at is where it is now.

/**
 * The collateral outpoint of the node listed at an address. An address given
 * without a port matches a node listed on any port of that IP.
 * @param {Array<{ip: string, txhash: string, outidx: number|string}>} nodeList
 * @param {string} socketAddress ip or ip:port
 * @returns {string|null} `txhash:outidx`
 */
function listedOutpointAt(nodeList, socketAddress) {
  const wanted = normalizeSocketAddress(socketAddress);
  if (!wanted) return null;
  const listed = nodeList.find((node) => {
    const nodeAddress = normalizeSocketAddress(node.ip);
    return nodeAddress === wanted || nodeAddress?.split(':')[0] === wanted;
  });
  return listed ? `${listed.txhash}:${listed.outidx}` : null;
}

/**
 * The address the node holding a collateral is listed at.
 * @param {Array<{ip: string, txhash: string, outidx: number|string}>} nodeList
 * @param {string} outpoint `txhash:outidx`
 * @returns {string|null} The normalized socket address, or null when the list does not carry it.
 */
function listedAddressOf(nodeList, outpoint) {
  const listed = nodeList.find((node) => `${node.txhash}:${node.outidx}` === outpoint);
  return listed ? normalizeSocketAddress(listed.ip) : null;
}

module.exports = {
  listedOutpointAt,
  listedAddressOf,
};
