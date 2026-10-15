import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appIdentityFromUuid, appUuid, isComponentKey } from '@runonflux/flux-spec';
import { buildV9ContentSpec } from '../framework/content-crypto-v9.js';
import { registrationKeys, updateKeys } from '../framework/component-keys.js';
import { componentIdentifier } from '../framework/container.js';

const OWNER = '1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm';
const REGISTRATION = 'a'.repeat(64);
const UPDATE = 'b'.repeat(64);

const submission = (components) => buildV9ContentSpec({ name: 'keyed', owner: OWNER, components });
const web = buildV9ContentSpec({ name: 'keyed', owner: OWNER }).components.web;
const identity = appIdentityFromUuid(appUuid('keyed', REGISTRATION));

test('a registration mints each component a key from the app\'s identity and the registration', () => {
  const keys = registrationKeys(submission({ web, db: { ...web, name: 'db', ports: {} } }), REGISTRATION);

  assert.deepEqual([...keys.keys()].sort(), ['db', 'web']);
  assert.ok(isComponentKey(keys.get('web')));
  assert.notEqual(keys.get('web'), keys.get('db'));
  assert.deepEqual(registrationKeys(submission({ web, db: { ...web, name: 'db', ports: {} } }), REGISTRATION), keys, 'the same registration gives the same keys');
  assert.notDeepEqual(registrationKeys(submission({ web, db: { ...web, name: 'db', ports: {} } }), UPDATE), keys, 'another message mints other keys');
});

test('an update carries a renamed component\'s key and mints one for a name declared again', () => {
  const registered = registrationKeys(submission({ web }), REGISTRATION);

  const renamed = updateKeys(submission({ site: { ...web, name: 'site', renamedFrom: 'web' } }), UPDATE, { previous: registered, identity });
  assert.deepEqual([...renamed], [['site', registered.get('web')]]);

  const again = updateKeys(submission({ web: { ...web, cpu: 0.7 } }), UPDATE, { previous: new Map([['site', registered.get('web')]]), identity });
  assert.ok(isComponentKey(again.get('web')));
  assert.notEqual(again.get('web'), registered.get('web'));
});

test('an update refuses to guess the keys it carries or the app they belong to', () => {
  const spec = submission({ web });
  assert.throws(() => updateKeys(spec, UPDATE, { identity }), /^Error: updateKeys\(keyed\): state the keys of the version it updates$/);
  assert.throws(() => updateKeys(spec, UPDATE, { previous: new Map() }), /^Error: updateKeys\(keyed\): state the app's identity$/);
  assert.throws(() => registrationKeys(spec, 'not-a-hash'), /^Error: registrationKeys\(keyed\): the message hash the door answered is not one/);
});

test('a built app\'s component identifier is its key and its identity', () => {
  const componentKeys = registrationKeys(submission({ web }), REGISTRATION);
  const v9 = { spec: { name: 'keyed' }, identity, componentKeys };
  assert.equal(componentIdentifier(v9, 'web'), `${componentKeys.get('web')}_${identity}`);
  assert.throws(() => componentIdentifier(v9, 'db'), /^Error: componentIdentifier: keyed has no component db$/);

  const v8 = { spec: { name: 'legacy', version: 8 }, identity };
  assert.equal(componentIdentifier(v8), `legacy_${identity}`, 'a pre-v9 component is keyed by its name');

  assert.throws(
    () => componentIdentifier({ spec: { name: 'keyed' }, identity }, 'web'),
    /^Error: componentIdentifier: keyed states no componentKeys, and only a pre-v9 app's components are keyed by their names$/,
  );
});
