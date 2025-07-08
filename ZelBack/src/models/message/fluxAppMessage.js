// const dbHelper = require("../dbHelper");

const { FluxAppMessageV1 } = require("./v1/fluxAppMessageV1");

class FluxAppMessage {
  /**
   *
   * @param {Object} blob
   * @returns {FluxAppMessageV1 | null}
   */
  static fromBlob(blob) {
    const { version = null } = blob;

    // this is easily extensible to accomodate older versions
    switch (version) {
      case 1:
        return FluxAppMessageV1.fromBlob(blob);
      default:
        return null;
    }
  }
}

module.exports = { FluxAppMessage };

if (require.main === module) {
  const util = require("node:util");

  const messageRaw = {
    type: "fluxappupdate",
    version: 1,
    appSpecifications: {
      version: 8,
      name: "test",
      description: "tst",
      owner: "1ECC8hg91C8u3Hg5JFnzL9ZSgBP78fwRv9",
      compose: [
        {
          name: "hns",
          description: "hns",
          repotag: "wirewrex/flux-mini-fdm:flux",
          ports: [80, 443, 8080],
          domains: ["", "", ""],
          environmentParameters: [
            "DNS_SERVER_ADDRESS=https://varo.domains/api",
            "APP_NAME=radiusraid",
            "APP_PORT=36025",
            "DOMAIN=radiusraid.fluxos",
            "CERT=self",
            "FRONTEND_HEALTH_INTERVAL=1",
            "BACKEND_HEALTH_INTERVAL=90",
          ],
          commands: [],
          containerPorts: [80, 443, 8080],
          containerData: "s:/etc/nginx/certs",
          cpu: 0.5,
          ram: 500,
          hdd: 2,
          repoauth: "",
        },
      ],
      instances: 3,
      contacts: [],
      geolocation: [],
      expire: 22000,
      nodes: [
        "38.88.125.124",
        "65.109.29.157",
        "168.119.138.140",
        "65.109.29.206",
        "144.76.199.15",
        "65.108.72.251",
        "38.88.125.52",
        "94.130.141.124",
      ],
      staticip: false,
    },
    hash: "e9d4966994930258e3bd4f684a22f00e4de0db1cc4478a1071ec1c7cae270196",
    timestamp: 1689969754386,
    signature:
      "Hw1K1fmG+6QGeEeF0vcMRMGNtA6YdUchjZXsarz4jqWNXlUH6NJpwo1Gj7TyVe4Dje3cn4feO9qKrcchZuCoxK0=",
    txid: "9e0ce17c4d022422df5c62dbbd8626e16a1720f5bef0ef90bf4370d4548781fb",
    height: 1430074,
    valueSat: 202000000,
  };

  const message = FluxAppMessage.fromBlob(messageRaw);
  console.log(util.inspect(message, { colors: true }));
  console.log("====");
  console.log(util.inspect(message.formatted, { colors: true, depth: null }));
  console.log("HASH VERIFIED", message.verifySha256Hash());
}
