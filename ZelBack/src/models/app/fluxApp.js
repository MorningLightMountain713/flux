// const dbHelper = require("../dbHelper");

const { FluxAppV8 } = require("./v8/fluxAppV8");

class FluxApp {
  /**
   *
   * @param {Object} blob
   * @returns {FluxAppV8 | null}
   */
  static fromBlob(blob) {
    const { version = null } = blob;

    // this is easily extensible to accomodate older versions
    switch (version) {
      case 8:
        return FluxAppV8.fromBlob(blob);
      default:
        return null;
    }
  }
}

module.exports = { FluxApp };

if (require.main === module) {
  const util = require("node:util");

  const appRaw = {
    name: "wordpress1687539310160",
    compose: [
      {
        name: "wp",
        description: "wp",
        repotag: "runonflux/wp-nginx:latest",
        ports: [36825],
        domains: ["https://www.hivedrip.com"],
        environmentParameters: [
          "WORDPRESS_DB_HOST=fluxoperator_wordpress1687539310160:3307",
          "WORDPRESS_DB_USER=root",
          "WORDPRESS_DB_PASSWORD=secret",
          "WORDPRESS_DB_NAME=test_db",
        ],
        commands: [],
        containerPorts: [80],
        containerData: "s:/var/www/html/wp-content/",
        cpu: 1,
        ram: 1000,
        hdd: 20,
        tiered: false,
        repoauth: "",
      },
      {
        name: "mysql",
        description: "mysql",
        repotag: "mysql:8.3.0",
        ports: [],
        domains: [],
        environmentParameters: [
          "MYSQL_ROOT_PASSWORD=123secret",
          "MYSQL_ROOT_HOST=172.0.0.0/255.0.0.0",
        ],
        commands: [],
        containerPorts: [],
        containerData: "/var/lib/mysql",
        cpu: 1,
        ram: 1000,
        hdd: 20,
        tiered: false,
        repoauth: "",
      },
      {
        name: "operator",
        description: "operator",
        repotag: "runonflux/shared-db:latest",
        ports: [38338, 35747, 35487],
        domains: ["", "", ""],
        environmentParameters: [
          "DB_COMPONENT_NAME=fluxmysql_wordpress1687539310160",
          "DB_INIT_PASS=123secret",
          "CLIENT_APPNAME=wordpress1687539310160",
          "DB_APPNAME=wordpress1687539310160",
          "API_PORT=35747",
          "DB_PORT=38338",
        ],
        commands: [],
        containerPorts: [3307, 7071, 8008],
        containerData: "/var/lib/operator",
        cpu: 1,
        ram: 1000,
        hdd: 2,
        tiered: false,
        repoauth: "",
      },
    ],
    contacts: ["bstrawn@gmail.com"],
    description: "WordPress on Flux",
    expire: 160064,
    geolocation: ["acNA"],
    hash: "4b2ecb6f03162838865c471e696d99be2dedebd25f716e1bbca8497201cf83dd",
    height: 1787447,
    instances: 3,
    owner: "1pk9w2VdPwqHiPme4KStBmuk1GKhbemmp",
    version: 8,
    nodes: [],
    staticip: false,
  };

  const app = FluxApp.fromBlob(appRaw);
  console.log(util.inspect(app, { colors: true }));
  console.log("====");
  console.log(util.inspect(app.formatted, { colors: true }));
}
