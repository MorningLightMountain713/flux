'use strict';

const { APP_MESSAGE_CLOCK_ALLOWANCE_MS } = require('../utils/appConstants');

/**
 * Refuse a message timestamp a submission cannot take: more than an hour old,
 * the message can no longer be paid; more than the clock allowance ahead, it is
 * dated ahead of this node.
 * @param {number} timestamp - ms
 * @param {number} [now] - ms
 * @throws {Error}
 */
function assertSubmittableTimestamp(timestamp, now = Date.now()) {
  if (timestamp < now - 1000 * 3600) {
    throw new Error('Message timestamp is over 1 hour old, not valid. Check if your computer clock is synced and restart the registration process.');
  }
  if (timestamp > now + APP_MESSAGE_CLOCK_ALLOWANCE_MS) {
    throw new Error('Message timestamp from future, not valid. Check if your computer clock is synced and restart the registration process.');
  }
}

module.exports = { assertSubmittableTimestamp };
