import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { folderDirectories } from '../framework/synced-data-keeper.js';

const state = {
  nodes: [
    {
      ip: '10.0.0.1',
      folders: [
        { id: 'fluxweb_app', path: '/mnt/appdata/flux-apps/web_identity' },
        { id: 'fluxdb_app', path: '/mnt/appdata/flux-apps/db_identity/' },
        { id: 'unsafe', path: '/mnt/appdata/flux-apps/a b' },
        { id: 'pathless' },
      ],
    },
    { ip: '10.0.0.2', folders: [{ id: 'fluxweb_app', path: '/elsewhere' }] },
  ],
};

describe('folderDirectories', () => {
  it('reads each folder where the node configured it, not at its id', () => {
    assert.equal(folderDirectories(state, '10.0.0.1').get('fluxweb_app'), '/mnt/appdata/flux-apps/web_identity');
  });

  it('drops a trailing slash, so a mount line and a suffix match it', () => {
    assert.equal(folderDirectories(state, '10.0.0.1').get('fluxdb_app'), '/mnt/appdata/flux-apps/db_identity');
  });

  it('reads the node asked about', () => {
    assert.equal(folderDirectories(state, '10.0.0.2').get('fluxweb_app'), '/elsewhere');
  });

  it('leaves out a path it could not quote and a folder with none', () => {
    const directories = folderDirectories(state, '10.0.0.1');
    assert.equal(directories.has('unsafe'), false);
    assert.equal(directories.has('pathless'), false);
  });

  it('holds nothing for a node or a state it cannot read', () => {
    assert.equal(folderDirectories(null, '10.0.0.1').size, 0);
    assert.equal(folderDirectories(state, '10.0.0.9').size, 0);
  });
});
