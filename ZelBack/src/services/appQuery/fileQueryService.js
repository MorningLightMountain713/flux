// File Query Service - Query functions for app file and folder operations
const fs = require('fs').promises;
const messageHelper = require('../messageHelper');
const verificationHelper = require('../verificationHelper');
const IOUtils = require('../IOUtils');
const log = require('../../lib/log');
const { sanitizePath, verifyRealPath } = require('../utils/pathSecurity');
const { resolveVolumeTarget } = require('../appSystem/volumeTarget');

/**
 * To get apps folder contents.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getAppsFolder(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname || '';
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, appname);
    if (authorized) {
      let { folder } = req.params;
      folder = folder || req.query.folder || '';
      // Browse at appid level to show appdata and all other mount points.
      const { mount } = await resolveVolumeTarget(req);
      // Sanitize folder path to prevent directory traversal attacks
      const filepath = sanitizePath(folder, mount);
      // Verify resolved path stays within the allowed base directory
      await verifyRealPath(filepath, mount);
      const options = {
        withFileTypes: false,
      };
      const files = await fs.readdir(filepath, options);
      const filesWithDetails = [];
      // eslint-disable-next-line no-restricted-syntax
      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        const fileStats = await fs.lstat(`${filepath}/${file}`);
        const isDirectory = fileStats.isDirectory();
        const isFile = fileStats.isFile();
        const isSymbolicLink = fileStats.isSymbolicLink();
        let fileFolderSize = fileStats.size;
        if (isDirectory) {
          // eslint-disable-next-line no-await-in-loop
          fileFolderSize = await IOUtils.getFolderSize(`${filepath}/${file}`);
        }
        const detailedFile = {
          name: file,
          size: fileFolderSize, // bytes
          isDirectory,
          isFile,
          isSymbolicLink,
          createdAt: fileStats.birthtime,
          modifiedAt: fileStats.mtime,
        };
        filesWithDetails.push(detailedFile);
      }
      const resultsResponse = messageHelper.createDataMessage(filesWithDetails);
      res.json(resultsResponse);
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

module.exports = {
  getAppsFolder,
};
