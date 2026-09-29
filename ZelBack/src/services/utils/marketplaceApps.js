'use strict';

/**
 * Whether an app's name carries a marketplace creation timestamp.
 *
 * A v1-v8 spec has no marketplace field, so the timestamp the marketplace
 * appends to the names it registers is the only mark it leaves on the
 * registration. Any number in the name past 2020 in epoch milliseconds is read
 * as that mark.
 *
 * It errs towards yes: an ordinary name holding a large number is taken for a
 * marketplace app, which costs a marketplace lookup and never a wrong price.
 *
 * @param {string} appName - name as registered
 * @returns {boolean}
 */
function isMarketplaceApp(appName) {
  if (!appName) return false;
  const nums = appName.match(/\d+/g);
  if (!nums) return false;
  const epoch2020 = Date.parse('2020-01-01');
  return nums.some((n) => Number(n) > epoch2020);
}

module.exports = {
  isMarketplaceApp,
};
