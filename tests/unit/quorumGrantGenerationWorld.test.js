'use strict';

const { expect } = require('chai');

const { worldOf, sameWorld } = require('../../ZelBack/src/services/quorumGrant/generationWorld');

describe('quorumGrant generationWorld', () => {
  const OWNER = 'alice';
  const BUYER = 'bob';
  const record = (generation, height, signer) => ({ signer, data: { generation, height } });

  describe('worldOf', () => {
    it('an app that never changed hands and stands on its registration: generation 0, no takeover height', () => {
      expect(worldOf({ record: null, aside: false, ownership: { owner: OWNER, from: 100, transferred: false } }))
        .to.deep.equal({
          generation: 0, height: null, record: null, aside: false,
        });
    });

    it('a transfer naming no record: the registration\'s generation 0, taken over at the height the transfer applied', () => {
      expect(worldOf({ record: null, aside: false, ownership: { owner: BUYER, from: 500, transferred: true } }))
        .to.include({ generation: 0, height: 500 });
    });

    it('a record the listed owner signed: its generation, from the height it names', () => {
      const r = record(2, 700, BUYER);
      expect(worldOf({ record: r, aside: false, ownership: { owner: BUYER, from: 500, transferred: true } }))
        .to.deep.equal({
          generation: 2, height: 700, record: r.data, aside: false,
        });
    });

    it('a record the transfer names, signed by an earlier owner: its generation, from the later of its height and the transfer', () => {
      const r = record(1, 300, OWNER);
      expect(worldOf({ record: r, aside: false, ownership: { owner: BUYER, from: 500, transferred: true } }))
        .to.include({ generation: 1, height: 500 });
    });

    it('a named record this node lacks is set aside', () => {
      expect(worldOf({ record: null, aside: true, ownership: { owner: BUYER, from: 500, transferred: true } }))
        .to.include({ aside: true });
    });

    it('no app row: the registration\'s world', () => {
      expect(worldOf({ record: null, aside: false, ownership: null })).to.include({ generation: 0, height: null });
    });
  });

  describe('sameWorld', () => {
    it('the same generation from the same height is one world', () => {
      expect(sameWorld({ generation: 1, height: 700 }, { generation: 1, height: 700 })).to.equal(true);
      expect(sameWorld({ generation: 0, height: null }, { generation: 0, height: null })).to.equal(true);
    });

    it('a sale naming no record keeps generation 0 and is another world', () => {
      expect(sameWorld({ generation: 0, height: null }, { generation: 0, height: 500 })).to.equal(false);
    });

    it('a transfer naming a record and one naming none take over at the same height and are two worlds', () => {
      const named = worldOf({ record: record(1, 300, OWNER), aside: false, ownership: { owner: BUYER, from: 500, transferred: true } });
      const none = worldOf({ record: null, aside: false, ownership: { owner: BUYER, from: 500, transferred: true } });
      expect(named.height).to.equal(none.height);
      expect(sameWorld(named, none)).to.equal(false);
    });

    it('a step back from generation 1 to 0 is another world', () => {
      expect(sameWorld({ generation: 1, height: 300 }, { generation: 0, height: 500 })).to.equal(false);
    });

    it('a holder seated before takeover heights were known reads as the registration\'s world', () => {
      expect(sameWorld({ generation: 0 }, { generation: 0, height: null })).to.equal(true);
    });
  });
});
