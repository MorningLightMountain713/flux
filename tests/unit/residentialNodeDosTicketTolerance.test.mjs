import { expect } from 'chai';
import service from '../../ZelBack/src/services/residentialNodeDosService.js';
import * as knobs from '../../test-infra/runner/framework/coupled-knobs.js';

describe('the ticket tolerance the harness models', () => {
  it('is the same multiple of the step that coupled-knobs derives from', () => {
    // Two files have to agree on this or the harness builds fleets the product
    // does not behave like: coupled-knobs sizes the departure interval to
    // outlast the tolerance, and sizes it from ITS OWN idea of what the
    // tolerance is. If that drifts below the real one, a departure stops
    // reading as a gap and the serialisation this paces silently stops
    // existing - green, and testing nothing.
    expect(service.MAX_TICKET_GAP_MS).to.equal(service.QUEUE_STEP_MS * knobs.TICKET_GAP_STEPS);
  });

  it('outlasts more than one give-up pass, so a late pass cannot trip it', () => {
    const passesPerStep = knobs.productionQueueRatio();

    // One step is 1.82 passes. The tolerance has to mean a pass was MISSED
    // rather than merely slow, so it has to clear two passes with room.
    expect(passesPerStep * knobs.TICKET_GAP_STEPS).to.be.above(3);
  });
});
