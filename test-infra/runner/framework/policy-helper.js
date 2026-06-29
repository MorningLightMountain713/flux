// Builds the on-chain policy a fresh harness chain lacks. The v9 submission path gates
// every "gated" feature (contentBlobs, contentSlots, the LB cluster, ...) behind a policy
// entitlement: entitlementsState.assertSpecEntitled denies a feature unless the owner's
// policy groups grant its bit, and an empty chain grants nothing. Group 0 is the default
// group every fluxid is implicitly a member of, so a single group-0 definition that opens
// the feature bits entitles every app owner. Seeded into each node's
// chainparams.policygroupmessages before boot, where rebuildPolicyGroupState replays it.
//
// This is the DB-inject precondition path (grant features so content suites can submit).
// Minting these as real OP_RETURN blocks through the explorerService 0x20 ingest is a
// separate concern, for when the harness exercises flux-spec-policy's chain path itself.
// See fluxos/HARNESS_POLICY_ENTITLEMENTS.md.
import { FEATURE_BIT, encodeGrantBitmap, PolicyGroupMessage } from '@runonflux/flux-spec-policy';

// The parsed PolicyGroupMessage explorerService would store and PolicyGroupHistory replays:
// a group-0 definition opening `features` (default: every gated feature). Granting all
// allocated bits is self-consistent — every feature's parent is granted too — so
// encodeDefinition's parent-tree check passes.
export function defaultGroupGrantMessage(features = Object.keys(FEATURE_BIT)) {
  const grants = Object.fromEntries(features.map((name) => [name, true]));
  const bitmap = encodeGrantBitmap(grants);
  const bytes = PolicyGroupMessage.encodeDefinition({
    groupId: PolicyGroupMessage.DEFAULT_GROUP_ID,
    bitmap,
    action: 'upsert',
  });
  return PolicyGroupMessage.parse(bytes);
}

// The chainparams.policygroupmessages row (the { txid, height, message } shape
// explorerService writes and rebuildPolicyGroupState reads). Height 1 so the grant is in
// force well before any app submission (~INITIAL_HEIGHT); txid is an opaque marker (the
// rebuild keys on message + height, never the txid).
export function defaultGroupGrantDoc(features) {
  return {
    txid: 'harness-policy-default-group-grant',
    height: 1,
    message: defaultGroupGrantMessage(features),
  };
}
