// const dbHelper = require("../dbHelper");

const { FluxAppSpecV8 } = require("./v8/fluxAppSpecV8");
const { FluxAppSpecV7 } = require("./v7/fluxAppSpecV7");

class FluxAppSpec {
  /**
   *
   * @param {Object} blob
   * @returns {FluxAppSpecV8 | null}
   */
  static fromBlob(blob) {
    const { version = null } = blob;

    // this is easily extensible to accomodate older versions
    switch (version) {
      case 8:
        return FluxAppSpecV8.fromBlob(blob);
      case 7:
        return FluxAppSpecV7.fromBlob(blob);
      default:
        return null;
    }
  }
}

module.exports = { FluxAppSpec };

if (require.main === module) {
  const util = require("node:util");
  const { FluxAppSpecComponentV8 } = require("./v8/fluxAppSpecComponentV8");

  // const specRaw = {
  //   name: "PresearchCustom",
  //   compose: [
  //     {
  //       name: "Presearch",
  //       description: "Presearch",
  //       repotag: "presearch/node:latest",
  //       ports: [39000],
  //       domains: [""],
  //       environmentParameters: [
  //         "REGISTRATION_CODE=78f261a5470f3547350397cfe6ea75c1",
  //         "STAKE=disconnected:oldest",
  //         "wallet:minimum",
  //         "ALLOW_DISCONNECTED_STAKE_TRANSFER_AFTER=30m",
  //       ],
  //       commands: [],
  //       containerPorts: [38253],
  //       containerData: "/app/node",
  //       cpu: 0.3,
  //       ram: 300,
  //       hdd: 2,
  //       repoauth: "",
  //     },
  //   ],
  //   contacts: ["peter@smagpie.com"],
  //   description: "Just a little presearch",
  //   expire: 69367,
  //   geolocation: [],
  //   hash: "4156086205181dca50acc62a56cae0ee1219cf5043958505986dbd8731f7ff45",
  //   height: 1903654,
  //   instances: 14,
  //   owner: "19EWnxSWq1J4TEvhCXnKFwnD2ZWQGqWFek",
  //   version: 8,
  //   nodes: [],
  //   staticip: false,
  // };
  const specRaw = {
    version: 8,
    name: "wordpress1695330800529",
    description: "WordPress on Flux",
    owner: "1GgZXRv9BMqFRhXjw1CY46pmeigbcY2Lgt",
    compose: [
      {
        name: "wp",
        description: "wp",
        repotag: "runonflux/wp-nginx:latest",
        ports: [37091],
        domains: ["https://powerme.au"],
        environmentParameters: [
          "WORDPRESS_DB_HOST=fluxoperator_wordpress1695330800529:3307",
          "WORDPRESS_DB_USER=root",
          "WORDPRESS_DB_PASSWORD=secret",
          "WORDPRESS_DB_NAME=test_db",
        ],
        commands: [],
        containerPorts: [80],
        containerData: "r:/var/www/html",
        cpu: 1,
        ram: 1000,
        hdd: 20,
        repoauth: "",
      },
      {
        name: "mysql",
        description: "mysql",
        repotag: "mysql:latest",
        ports: [],
        domains: [],
        environmentParameters: [
          "MYSQL_ROOT_PASSWORD=123secret",
          "MYSQL_ROOT_HOST=172.0.0.0/255.0.0.0",
        ],
        commands: ["--disable-log-bin"],
        containerPorts: [],
        containerData: "/var/lib/mysql",
        cpu: 1,
        ram: 1000,
        hdd: 20,
        repoauth: "",
      },
      {
        name: "operator",
        description: "operator",
        repotag: "runonflux/shared-db:latest",
        ports: [34341, 37435, 39796],
        domains: ["", "", ""],
        environmentParameters: [
          "DB_COMPONENT_NAME=fluxmysql_wordpress1695330800529",
          "DB_INIT_PASS=123secret",
          "CLIENT_APPNAME=wordpress1695330800529",
          "DB_APPNAME=wordpress1695330800529",
          "API_PORT= 37435",
          "DB_PORT=34341",
        ],
        commands: [],
        containerPorts: [3307, 7071, 8008],
        containerData: "r:/app/dumps",
        cpu: 1,
        ram: 1000,
        hdd: 2,
        repoauth: "",
      },
    ],
    instances: 3,
    contacts: ["markaus@pm.me"],
    geolocation: ["acNA"],
    // hash: "fd4d75abcc0e490c29151e710edb44cc30206c243fbb1ed71c611996442565e4",
    // height: 1811844,
    expire: 264000,
    nodes: [],
    staticip: false,
  };

  const spec = FluxAppSpec.fromBlob(specRaw);

  if (!spec) process.exit();
  console.log(util.inspect(spec, { colors: true }));
  console.log("----");

  spec.components.forEach((component) => {
    console.log("COERSED COMPONENT", component.coersed);
    console.log("COERSED PROPS", component.coersedProps);
  });
  console.log("----");
  specRaw.compose.forEach((component) => {
    const verifiedLoose = FluxAppSpecComponentV8.verify(component, {
      strict: false,
    });
    const verifiedStrict = FluxAppSpecComponentV8.verify(component);
    console.log("LOOSE", verifiedLoose, "STRICT", verifiedStrict);
  });
  console.log("----");
  console.log("VIABLE", spec.viable);
  console.log("COERSED APP SPEC:", spec.coersed);
  console.log(util.inspect(spec.coersedProps, { colors: true, depth: null }));
  console.log("----");
  console.log(util.inspect(spec.formatted, { colors: true, depth: null }));
}
