const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

const ROUTES_PATH = '../../ZelBack/src/services/utils/messageRoutes';

// Loaded for its side effect: the transport declares its types as it loads.
require('../../ZelBack/src/services/fluxCommunication');
const {
  registeredTypes, isOrdered, handlerFor, declaredIntent, needsOf,
} = require(ROUTES_PATH);
const { INTENT } = require('../../ZelBack/src/services/utils/messageIntent');
const capabilities = require('../../ZelBack/src/services/utils/capabilities');
const log = require('../../ZelBack/src/lib/log');

// A copy of the table with nothing registered: proxyquire loads the module afresh.
const freshTable = () => proxyquire(ROUTES_PATH, {});
const STORED = { needs: ['localDbPrepared'] };

// Questions one peer puts to another: each asker is answered, so none is filtered on content.
const ASK_TYPES = [
  'fluxapprequest', 'fluxpolicyrequest',
  'fluxappcontentmanifestindexrequest', 'fluxappcontentmanifestrequest',
  'fluxappingressindexrequest', 'fluxappingressrequest',
];

const GOSSIP_TYPES = [
  'zelappregister', 'zelappupdate', 'fluxappregister', 'fluxappupdate',
  'fluxapprunning', 'fluxipchanged', 'fluxappremoved', 'fluxappinstalling',
  'fluxappinstallingerror', 'fluxpolicyseq', 'fluxpolicy',
  'fluxlimitcounterrecord', 'fluxmasterlease', 'fluxnodedown', 'fluxnodedownverdict',
  'fluxgrantgeneration', 'fluxappcontentmanifest', 'fluxappingress',
  ...ASK_TYPES,
];

const ORDERED_TYPES = [
  'fluxapptempsync', 'fluxapprunningsync', 'fluxappinstallingsync',
  'fluxappinstallingerrorssync',
  'fluxappcontentmanifestindex', 'fluxappcontentmanifestsync',
  'fluxappingressindex', 'fluxappingresssync',
];

describe('messageRoutes tests', () => {
  describe('the table the transport actually loads', () => {
    it('declares every type this node answers', () => {
      // An empty table reads as "unrecognised message type" for everything, which is a
      // silent network outage. This is the guard that a registration cannot go missing.
      expect(registeredTypes()).to.include.members([...GOSSIP_TYPES, ...ORDERED_TYPES]);
    });

    it('gives each of them something to run', () => {
      [...GOSSIP_TYPES, ...ORDERED_TYPES].forEach((type) => {
        expect(handlerFor(type), type).to.be.a('function');
      });
    });

    it('orders the sync responses and nothing else', () => {
      // Ordered types go around the gossip pipeline, so one wrongly marked loses its
      // deduplication and one wrongly unmarked loses the order its chunks carry.
      expect(registeredTypes().filter(isOrdered).sort()).to.deep.equal([...ORDERED_TYPES].sort());
    });

    it('declares only fluxpolicyseq as sent both ways', () => {
      // VARIES is the type saying it travels in both directions, which makes it point to
      // point and never filtered on content. Anything relayed onward must never be VARIES,
      // or one node's copy of a fact suppresses every other route it arrives by.
      const varying = registeredTypes().filter((type) => declaredIntent(type) === INTENT.VARIES);
      expect(varying).to.deep.equal(['fluxpolicyseq']);
    });

    it('declares every relayed type an announcement', () => {
      // These are the types whose handlers rebroadcast, so deduplication is the only
      // thing that stops one copy becoming one per peer per hop.
      ['zelappregister', 'zelappupdate', 'fluxappregister', 'fluxappupdate',
        'fluxapprunning', 'fluxipchanged', 'fluxappremoved', 'fluxappinstalling',
        'fluxappinstallingerror', 'fluxlimitcounterrecord', 'fluxmasterlease', 'fluxnodedown',
        'fluxgrantgeneration', 'fluxappcontentmanifest', 'fluxappingress'].forEach((type) => {
        expect(declaredIntent(type), type).to.equal(INTENT.ANNOUNCE);
      });
    });

    // A verdict is pushed point to point, but it is the juror's signed statement: the same
    // bytes arriving twice are one verdict, so it is filtered as an announcement.
    it('filters a verdict on its content', () => {
      expect(declaredIntent('fluxnodedownverdict')).to.equal(INTENT.ANNOUNCE);
    });

    it('declares every question an ask', () => {
      ASK_TYPES.forEach((type) => expect(declaredIntent(type), type).to.equal(INTENT.ASK));
    });

    it('lets nothing that stores take a message before the database is prepared', () => {
      // A handler that stores while the database is down fails part way and says so in
      // a stack trace; declared, it is skipped and said under the capability.
      ['zelappregister', 'zelappupdate', 'fluxappregister', 'fluxappupdate',
        'fluxapprunning', 'fluxipchanged', 'fluxappremoved', 'fluxappinstalling',
        'fluxappinstallingerror', 'fluxlimitcounterrecord', 'fluxmasterlease', 'fluxnodedown',
        'fluxnodealive', 'fluxappingress', 'fluxapprequest',
        'fluxappcontentmanifestindexrequest', 'fluxappcontentmanifestrequest',
        'fluxappingressindexrequest', 'fluxappingressrequest',
        'fluxapptempsync', 'fluxapprunningsync', 'fluxappinstallingsync',
        'fluxappinstallingerrorssync', 'fluxappcontentmanifestsync', 'fluxappingresssync'].forEach((type) => {
        expect(needsOf(type), type).to.deep.equal(['localDbPrepared']);
      });
    });

    it('judges gossip that names an app\'s signer only against a consistent app list', () => {
      ['fluxappcontentmanifest', 'fluxgrantgeneration'].forEach((type) => {
        expect(needsOf(type), type).to.deep.equal(['localDbPrepared', 'appRegistryConsistent']);
      });
    });

    it('never holds an app message for the app list', () => {
      // Hash sync's answers arrive as these types and the app list waits on hash sync,
      // so an app message waiting on the list would never arrive.
      ['zelappregister', 'zelappupdate', 'fluxappregister', 'fluxappupdate'].forEach((type) => {
        expect(needsOf(type), type).to.not.include('appRegistryConsistent');
      });
    });

    it('handles what lives in this process whatever is down', () => {
      // A node with no policy says so: that answer is how a new network starts.
      ['fluxpolicyrequest', 'fluxpolicyseq', 'fluxpolicy', 'fluxnodedownverdict',
        'fluxappcontentmanifestindex', 'fluxappingressindex'].forEach((type) => {
        expect(needsOf(type), type).to.deep.equal([]);
      });
    });

    it('claims nothing it was not given', () => {
      expect(handlerFor('fluxnotathing')).to.equal(null);
      expect(isOrdered('fluxnotathing')).to.equal(false);
    });
  });

  describe('the table itself', () => {
    it('takes several types onto one handler', () => {
      const table = freshTable();
      const handler = () => 'handled';
      table.register(['one', 'two'], handler, table.ROUTE.GOSSIP, INTENT.ANNOUNCE, STORED);
      expect(table.handlerFor('one')).to.equal(handler);
      expect(table.handlerFor('two')).to.equal(handler);
    });

    it('takes the last declaration for a type', () => {
      const table = freshTable();
      const second = () => 'second';
      table.register('twice', () => 'first', table.ROUTE.GOSSIP, INTENT.ANNOUNCE, STORED);
      table.register('twice', second, table.ROUTE.ORDERED, INTENT.ANSWER, { none: table.NONE.PROCESS });
      expect(table.handlerFor('twice')).to.equal(second);
      expect(table.isOrdered('twice')).to.equal(true);
      expect(table.declaredIntent('twice')).to.equal(INTENT.ANSWER);
      expect(table.needsOf('twice')).to.deep.equal([]);
    });

    it('refuses a type that does not say how it travels or what it is', () => {
      // The whole point of making both required. A type registered without an intent
      // would inherit whatever the default was, and the default that is wrong for one
      // type is the one that floods the network.
      const table = freshTable();
      expect(() => table.register('nothing', () => {})).to.throw(/declares no route/);
      expect(() => table.register('noroute', () => {}, 'sideways', INTENT.ANNOUNCE)).to.throw(/declares no route/);
      expect(() => table.register('nointent', () => {}, table.ROUTE.GOSSIP)).to.throw(/declares no intent/);
      expect(() => table.register('bogus', () => {}, table.ROUTE.GOSSIP, 'whatever')).to.throw(/declares no intent/);
    });

    it('refuses a type that does not say what it reads', () => {
      const table = freshTable();
      const { GOSSIP } = table.ROUTE;
      expect(() => table.register('silent', () => {}, GOSSIP, INTENT.ANNOUNCE)).to.throw(/declares neither/);
      expect(() => table.register('both', () => {}, GOSSIP, INTENT.ANNOUNCE, { needs: ['localDbPrepared'], none: 'x' }))
        .to.throw(/declares neither/);
      expect(() => table.register('typo', () => {}, GOSSIP, INTENT.ANNOUNCE, { needs: ['localDbPrepard'] }))
        .to.throw(/unknown capability localDbPrepard/);
      expect(table.registeredTypes()).to.deep.equal([]);
    });

    it('reads an unregistered type as an announcement', () => {
      // It has no handler, so it is dropped either way - but deduplicating it first
      // means a peer cannot make us do the work twice by sending it twice.
      const table = freshTable();
      expect(table.declaredIntent('fluxnotathing')).to.equal(INTENT.ANNOUNCE);
    });
  });
  describe('what a type needs, against what is up', () => {
    beforeEach(() => capabilities.resetForTests());
    afterEach(() => {
      sinon.restore();
      capabilities.resetForTests();
    });

    it('names the first capability a type needs that is not up, and none once all are', () => {
      const table = freshTable();
      table.register('listed', () => {}, table.ROUTE.GOSSIP, INTENT.ANNOUNCE, { needs: ['localDbPrepared', 'appRegistryConsistent'] });
      expect(table.unmetNeed('listed')).to.equal('localDbPrepared');
      capabilities.setForTests('localDbPrepared', true);
      expect(table.unmetNeed('listed')).to.equal('appRegistryConsistent');
      capabilities.setForTests('appRegistryConsistent', true);
      expect(table.unmetNeed('listed')).to.equal(null);
    });

    it('holds back nothing that reads no capability, nor a type it does not know', () => {
      const table = freshTable();
      table.register('inproc', () => {}, table.ROUTE.GOSSIP, INTENT.ANNOUNCE, { none: table.NONE.PROCESS });
      expect(table.unmetNeed('inproc')).to.equal(null);
      expect(table.unmetNeed('fluxnotathing')).to.equal(null);
    });
  });

  describe('a skipped message is said once per type while its capability is down', () => {
    let warn;
    let info;

    beforeEach(() => {
      capabilities.resetForTests();
      warn = sinon.stub(log, 'warn');
      info = sinon.stub(log, 'info');
    });

    afterEach(() => {
      sinon.restore();
      capabilities.resetForTests();
    });

    const skipLines = (stub) => stub.getCalls().map((call) => call.args[0]).filter((line) => line.startsWith('messageRoutes:'));

    it('says each type the first time, and the counts when the capability is up', () => {
      const table = freshTable();
      ['a', 'a', 'a', 'b'].forEach((type) => table.noteSkipped(type, 'localDbPrepared'));
      expect(skipLines(warn)).to.deep.equal([
        'messageRoutes: skipping a while localDbPrepared is not up',
        'messageRoutes: skipping b while localDbPrepared is not up',
      ]);
      expect(skipLines(info)).to.deep.equal([]);

      capabilities.setForTests('localDbPrepared', true);
      expect(skipLines(info)).to.deep.equal([
        'messageRoutes: localDbPrepared is up; skipped while it was not: 3 a, 1 b',
      ]);
    });

    it('starts again the next time the capability goes down', () => {
      const table = freshTable();
      table.noteSkipped('a', 'localDbPrepared');
      capabilities.setForTests('localDbPrepared', true);
      capabilities.setForTests('localDbPrepared', false);
      table.noteSkipped('a', 'localDbPrepared');
      capabilities.setForTests('localDbPrepared', true);
      expect(skipLines(warn)).to.have.length(2);
      expect(skipLines(info)).to.deep.equal([
        'messageRoutes: localDbPrepared is up; skipped while it was not: 1 a',
        'messageRoutes: localDbPrepared is up; skipped while it was not: 1 a',
      ]);
    });

    it('keeps one capability\'s skips apart from another\'s', () => {
      const table = freshTable();
      table.noteSkipped('a', 'localDbPrepared');
      table.noteSkipped('m', 'appRegistryConsistent');
      capabilities.setForTests('localDbPrepared', true);
      expect(skipLines(info)).to.deep.equal([
        'messageRoutes: localDbPrepared is up; skipped while it was not: 1 a',
      ]);
    });
  });
});
