'use strict';

const net = require('net');
const { once } = require('events');
const { expect } = require('chai');
const { violations } = require('../noRealNetwork');

// The unit tier's network guard, for a connection that resolves its name through
// its own lookup: decided by the address the lookup answers, since that is where
// the socket goes.
describe('the unit network guard, for a connection with its own lookup', () => {
  let server;
  let port;

  beforeEach(async () => {
    server = net.createServer((socket) => socket.end('reached'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    ({ port } = server.address());
  });

  afterEach(async () => {
    server.close();
    await once(server, 'close');
  });

  // A lookup in node's shape: one address, or a list when asked for all of them.
  const answering = (address) => (hostname, options, callback) => {
    process.nextTick(() => (options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4)));
  };

  // Settles with what the socket did: its data, or the error it closed with.
  function dial(lookup) {
    return new Promise((resolve) => {
      const socket = net.connect({ host: 'guarded-name.invalid', port, lookup });
      let data = '';
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('end', () => resolve({ data }));
      socket.on('error', (error) => resolve({ error }));
    });
  }

  it('reaches this process\'s own server when the lookup answers loopback, and records nothing', async () => {
    const before = violations.length;

    const { data, error } = await dial(answering('127.0.0.1'));

    expect(error).to.equal(undefined);
    expect(data).to.equal('reached');
    expect(violations.length).to.equal(before);
  });

  it('refuses and records a connection the lookup sends to another host', async () => {
    const before = violations.length;

    const { error } = await dial(answering('203.0.113.7'));

    expect(error.message).to.match(/blocked: unit tests must not use the network/);
    expect(violations.length).to.equal(before + 1);
    // Recorded as it must be; taken back so the run's report names real callers only.
    violations.splice(before, 1);
  });

  it('fails as the lookup says when it cannot place the name, and records nothing', async () => {
    const before = violations.length;
    const notFound = (hostname, options, callback) => {
      process.nextTick(() => callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })));
    };

    const { error } = await dial(notFound);

    expect(error.code).to.equal('ENOTFOUND');
    expect(violations.length).to.equal(before);
  });
});
