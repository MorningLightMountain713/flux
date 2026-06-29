const CONTROL_PORT = 16128;

export function stubPeerClient(ip) {
  const controlUrl = `http://${ip}:${CONTROL_PORT}`;

  return {
    ip,
    controlUrl,

    async loadMessage(permanentMessage) {
      const res = await fetch(`${controlUrl}/load-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(permanentMessage),
      });
      return res.json();
    },

    async getStats() {
      const res = await fetch(`${controlUrl}/stats`);
      return res.json();
    },

    // Push an unsolicited node-signed gossip broadcast (the stub signs the envelope with
    // its own node key) to every connected node. `data` is the inner gossip payload, e.g.
    // { type: 'fluxappcontentmanifest', appName, manifest } with a forged owner signature.
    async broadcast(data) {
      const res = await fetch(`${controlUrl}/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      return res.json();
    },

    async clear() {
      const res = await fetch(`${controlUrl}/clear`, { method: 'POST' });
      return res.json();
    },
  };
}
