/**
 * The committee a node's walk seats for a held key at a generation, over the
 * membership that node holds now: the members as outpoints, and the quorum.
 * Throws when the walk seats none.
 *
 * @param {string} nodeUrl
 * @param {string} key the grant key, `<identity>/<role>`
 * @param {number} generation
 * @returns {Promise<{ members: Set<string>, quorum: number, size: number }>}
 */
export async function committeeFor(nodeUrl, key, generation) {
  const res = await fetch(`${nodeUrl}/flux/quorumgrant/committee?key=${encodeURIComponent(key)}&generation=${generation}`);
  const body = await res.json();
  if (body.status !== 'success' || !body.data) {
    throw new Error(`committee read failed for ${key}@${generation}: ${JSON.stringify(body)}`);
  }
  if (body.data.refusal) {
    throw new Error(`the walk seats no committee for ${key}@${generation}: ${body.data.refusal}`);
  }
  return { members: new Set(body.data.members.map((m) => m.outpoint)), quorum: body.data.quorum, size: body.data.size };
}
