import { appOwnerKey, userKey } from './keys.js';
import { registerAndConfirm, confirmOnChain } from './app-helper.js';
import { updateEncryptedV9App } from './content-helper.js';

// A sale: the owner on record signs an update whose spec names another owner, and
// the chain confirms it like any update. The buyer is the harness's second owner
// key unless given. For a v8 app, cleartext or enterprise, the update is the app's
// spec with the owner changed and is signed by the seller. For an encrypted v9
// app the submission names the buyer, is sealed to the transport key of the name
// and the buyer, since the node stores the spec sealed for the owner it names,
// and is signed by the seller; `standsOn` names what the sale stands on, the
// manifest in the spec's `content` block as `sha256:<hex>` and the generation
// records by hash per role in its `grants` block. The returned app keeps the identity its
// registration minted: a sale changes the owner, never the identity.

export const buyerKey = () => userKey();

/**
 * @param {string} nodeUrl - the node that takes the submission
 * @param {object} adminKeypair - the login the submission is made under
 * @param {{spec: object, hash: string, uuid?: string, identity?: string}} app - as
 *   registerAndConfirm returned it: for an encrypted v9 app the fields the
 *   submission is rebuilt from go in `v9`
 * @param {Array} nodes - the fleet the confirmation waits on
 * @param {object} [opts] - { sellerKey, buyerKey, standsOn: { manifest?, grants? },
 *   v9: { image, instances, ttl, components, placement, assignment, specOverrides? },
 *   propagationTimeoutMs, explorerTimeoutMs, valueSat }
 * @returns {Promise<object>} the confirmation result with `app` under the buyer
 */
export async function transferApp(nodeUrl, adminKeypair, app, nodes, {
  sellerKey = appOwnerKey(),
  buyerKey: buyer = buyerKey(),
  standsOn = {},
  v9 = null,
  ...confirmOpts
} = {}) {
  const sold = (result, updateHash) => ({
    ...result,
    app: {
      ...app,
      spec: { ...app.spec, owner: buyer.zelid, hash: updateHash },
      seller: sellerKey.zelid,
      buyer: buyer.zelid,
    },
  });

  if (v9) {
    const named = {
      ...(standsOn.manifest ? { content: { manifest: standsOn.manifest } } : {}),
      ...(standsOn.grants ? { grants: standsOn.grants } : {}),
    };
    const submitted = await updateEncryptedV9App(nodeUrl, {
      ...v9,
      name: app.spec.name,
      owner: buyer.zelid,
      ownerKey: sellerKey,
      specOverrides: { ...(v9.specOverrides || {}), ...named },
    });
    if (submitted.status !== 'success') return submitted;
    const updateHash = submitted.data;
    const confirm = await confirmOnChain(updateHash, nodes, confirmOpts);
    return sold({ status: 'success', appHash: updateHash, contentHash: submitted.contentHash, ...confirm }, updateHash);
  }

  const { hash, ...spec } = app.spec;
  const result = await registerAndConfirm(nodeUrl, adminKeypair, { ...spec, owner: buyer.zelid }, nodes, {
    ...confirmOpts, type: 'fluxappupdate', signerKey: sellerKey,
  });
  if (result.status !== 'success') return result;
  return sold(result, result.appHash);
}
