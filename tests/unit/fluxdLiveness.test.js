const { expect } = require('chai');
const sinon = require('sinon');

const { createFluxdLiveness } = require('../../ZelBack/src/services/utils/fluxdLiveness');

describe('fluxdLiveness tests', () => {
  let elapsed;
  let probe;
  let changes;

  function build(overrides = {}) {
    return createFluxdLiveness({
      elapsedSinceMessageMs: () => elapsed,
      probe,
      onChange: (alive) => changes.push(alive),
      silenceThresholdMs: 90_000,
      probeIntervalMs: 30_000,
      ...overrides,
    });
  }

  beforeEach(() => {
    elapsed = 0;
    changes = [];
    probe = sinon.stub().resolves(true);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should not probe while messages are arriving', async () => {
    elapsed = 1000;
    const liveness = build();

    await liveness.checkNow();

    sinon.assert.notCalled(probe);
    expect(liveness.alive()).to.equal(true);
  });

  it('should probe once the silence threshold is crossed', async () => {
    elapsed = 120_000;
    const liveness = build();

    await liveness.checkNow();

    sinon.assert.calledOnce(probe);
    expect(liveness.alive()).to.equal(true);
  });

  it('should probe when no message has ever arrived', async () => {
    elapsed = null;
    const liveness = build();

    await liveness.checkNow();

    sinon.assert.calledOnce(probe);
  });

  it('should only declare the daemon unreachable when the probe fails', async () => {
    elapsed = 600_000;
    probe.resolves(false);
    const liveness = build();

    await liveness.checkNow();

    expect(liveness.alive()).to.equal(false);
    expect(changes).to.eql([false]);
  });

  it('should treat a throwing probe as unreachable', async () => {
    elapsed = 600_000;
    probe.rejects(new Error('test: ECONNREFUSED'));
    const liveness = build();

    await liveness.checkNow();

    expect(liveness.alive()).to.equal(false);
    expect(liveness.lastProbeSucceeded()).to.equal(false);
  });

  it('should stay alive through a long silence when the probe answers', async () => {
    elapsed = 3_600_000;
    const liveness = build();

    await liveness.checkNow();

    expect(liveness.alive()).to.equal(true);
    expect(changes).to.eql([]);
  });

  it('should rate limit probes during a sustained silence', async () => {
    elapsed = 600_000;
    const liveness = build();

    await liveness.checkNow();
    await liveness.checkNow();
    await liveness.checkNow();

    sinon.assert.calledOnce(probe);
  });

  it('should recover to alive when a message arrives after a failed probe', async () => {
    elapsed = 600_000;
    probe.resolves(false);
    const liveness = build();
    await liveness.checkNow();
    expect(liveness.alive()).to.equal(false);

    elapsed = 500;
    await liveness.checkNow();

    expect(liveness.alive()).to.equal(true);
    expect(changes).to.eql([false, true]);
  });

  it('should report a transition only once per change', async () => {
    elapsed = 600_000;
    probe.resolves(false);
    const liveness = build({ probeIntervalMs: 0 });

    await liveness.checkNow();
    await liveness.checkNow();
    await liveness.checkNow();

    expect(changes).to.eql([false]);
  });

  it('should not stack probes when one is slower than the check interval', async () => {
    elapsed = 600_000;
    let release;
    probe = sinon.stub().returns(new Promise((resolve) => { release = resolve; }));
    const liveness = build({ probeIntervalMs: 0 });

    const first = liveness.checkNow();
    const second = liveness.checkNow();

    release(true);
    await Promise.all([first, second]);

    sinon.assert.calledOnce(probe);
  });

  it('should start alive so a slow first probe cannot shed apps', () => {
    expect(build().alive()).to.equal(true);
  });

  it('should stop evaluating once stopped', async () => {
    elapsed = 600_000;
    const liveness = build({ checkIntervalMs: 5 });

    liveness.start();
    liveness.stop();

    await new Promise((resolve) => { setTimeout(resolve, 60); });

    sinon.assert.notCalled(probe);
  });

  it('should require an elapsed function', () => {
    expect(() => createFluxdLiveness({ probe: () => true }))
      .to.throw('An elapsedSinceMessageMs function is mandatory');
  });

  it('should require a probe function', () => {
    expect(() => createFluxdLiveness({ elapsedSinceMessageMs: () => 0 }))
      .to.throw('A probe function is mandatory');
  });
});
