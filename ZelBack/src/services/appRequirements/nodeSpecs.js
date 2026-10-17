'use strict';

const os = require('os');
const benchmarkService = require('../benchmarkService');
const log = require('../../lib/log');

// This node's hardware: cores, RAM in MB and SSD in GB, each read once.
const nodeSpecs = {
  cpuCores: 0,
  ram: 0,
  ssdStorage: 0,
};

async function getNodeSpecs() {
  try {
    if (nodeSpecs.cpuCores === 0) {
      nodeSpecs.cpuCores = os.cpus().length;
    }
    if (nodeSpecs.ram === 0) {
      nodeSpecs.ram = os.totalmem() / 1024 / 1024;
    }
    if (nodeSpecs.ssdStorage === 0) {
      const { value: benchmarks } = await benchmarkService.getBenchmarks();
      if (benchmarks) {
        log.info(`Gathered ssdstorage ${benchmarks.ssd}`);
        nodeSpecs.ssdStorage = benchmarks.ssd;
      } else {
        throw new Error('Error getting ssdstorage from benchmarks');
      }
    }
  } catch (error) {
    log.error(error);
  }
  return nodeSpecs;
}

module.exports = {
  getNodeSpecs,
};
