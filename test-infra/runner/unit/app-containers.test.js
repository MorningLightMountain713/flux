// listAppContainers reads one line per container from `docker ps --format`.
// `npm run test:unit`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppContainers } from '../framework/container.js';

const line = (fields) => fields.join('\t');

describe('parseAppContainers', () => {
  it('reads a v9 container by its labels', () => {
    const [c] = parseAppContainers(line(['web_bident', 'Up 3 minutes', 'img:v1', 'myapp', 'web', '', 'web_bident', 'bident', '', '']));

    assert.equal(c.app, 'myapp');
    assert.equal(c.component, 'web');
    assert.equal(c.identifier, 'web_bident');
  });

  it('reads a container a release before v9 made by that release\'s labels', () => {
    const [c] = parseAppContainers(line(['fluxweb_myapp', 'Up 3 minutes', 'img:v1', '', '', '', '', '', 'myapp', 'web']));

    assert.equal(c.app, 'myapp');
    assert.equal(c.component, 'web');
    assert.equal(c.identifier, null);
  });

  it('reads a container no FluxOS labelled as belonging to no app', () => {
    const [c] = parseAppContainers(line(['stranger', 'Up 1 second', 'busybox', '', '', '', '', '', '', '']));

    assert.equal(c.app, null);
    assert.equal(c.component, null);
  });
});
