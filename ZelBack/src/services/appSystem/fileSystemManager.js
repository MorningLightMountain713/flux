// File System Manager - Manages filesystem operations for FluxOS applications
const archiver = require('archiver');
const { PassThrough } = require('stream');
const path = require('path');
const messageHelper = require('../messageHelper');
const verificationHelper = require('../verificationHelper');
const serviceHelper = require('../serviceHelper');
const fs = require('fs').promises;
const log = require('../../lib/log');
const { formidable } = require('formidable');
const {
  sanitizePath, validateFilename, verifyRealPath, verifyRealPathOfExistingPath,
} = require('../utils/pathSecurity');
const { resolveVolumeTarget } = require('./volumeTarget');

/**
 * To create a folder in app's volume. Only accessible by app owners and above.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function createAppsFolder(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname || '';
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, appname);
    if (authorized) {
      let { folder } = req.params;
      folder = folder || req.query.folder || '';
      const { mount } = await resolveVolumeTarget(req);
      // Sanitize folder path to prevent directory traversal attacks, then
      // verify the resolved path stays within the volume it was built from.
      const filepath = sanitizePath(folder, mount);
      await verifyRealPathOfExistingPath(filepath, mount);
      const mkdirResult = await serviceHelper.runCommand('mkdir', { runAsRoot: true, params: [filepath] });
      if (mkdirResult.error) {
        throw mkdirResult.error;
      }
      const resultsResponse = messageHelper.createSuccessMessage('Folder Created');
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

/**
 * To rename a file or folder. Oldpath is relative path to default fluxshare directory; newname is just a new name of folder/file. Only accessible by admins.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function renameAppsObject(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname || '';
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, appname);
    if (authorized) {
      let { oldpath } = req.params;
      let { component } = req.params;
      component = component || req.query.component || '';
      if (!appname || !component) {
        throw new Error('appname and component parameters are mandatory');
      }
      oldpath = oldpath || req.query.oldpath;
      if (!oldpath) {
        throw new Error('No file nor folder to rename specified');
      }
      let { newname } = req.params;
      newname = newname || req.query.newname;
      if (!newname) {
        throw new Error('No new name specified');
      }
      if (newname.includes('/')) {
        throw new Error('New name is invalid');
      }
      // stop sharing of ALL files that start with the path
      const fileURI = encodeURIComponent(oldpath);
      const { mount } = await resolveVolumeTarget(req);
      // Sanitize paths to prevent directory traversal attacks
      const oldfullpath = sanitizePath(oldpath, mount);
      let newfullpath = sanitizePath(newname, mount);
      const fileURIArray = fileURI.split('%2F');
      fileURIArray.pop();
      if (fileURIArray.length > 0) {
        const renamingFolder = fileURIArray.join('/');
        // Sanitize the combined path as well
        newfullpath = sanitizePath(`${renamingFolder}/${newname}`, mount);
      }
      // Verify parent directories resolve within the allowed base directory to prevent symlink escapes.
      await verifyRealPathOfExistingPath(path.dirname(oldfullpath), mount);
      await verifyRealPathOfExistingPath(path.dirname(newfullpath), mount);

      // Allow renaming symlinks directly (mv renames the link itself, not the target).
      // For non-symlink targets, enforce full real path containment.
      let isSymbolicLink = false;
      try {
        const stats = await fs.lstat(oldfullpath);
        isSymbolicLink = stats.isSymbolicLink();
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
      if (!isSymbolicLink) {
        await verifyRealPath(oldfullpath, mount);
      }
      const mvResult = await serviceHelper.runCommand('mv', { runAsRoot: true, params: ['-T', oldfullpath, newfullpath] });
      if (mvResult.error) {
        throw mvResult.error;
      }
      const response = messageHelper.createSuccessMessage('Rename successful');
      res.json(response);
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    try {
      res.write(serviceHelper.ensureString(errorResponse));
      res.end();
    } catch (e) {
      log.error(e);
    }
  }
}

/**
 * To remove a specified shared file. Only accessible by admins.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function removeAppsObject(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname || '';
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, appname);
    if (authorized) {
      let { object } = req.params;
      object = object || req.query.object;
      let { component } = req.params;
      component = component || req.query.component || '';
      if (!component) {
        throw new Error('component parameter is mandatory');
      }
      if (!object) {
        throw new Error('No object specified');
      }
      const { mount } = await resolveVolumeTarget(req);
      // Sanitize object path to prevent directory traversal attacks
      const filepath = sanitizePath(object, mount);
      // Verify parent directories resolve within the allowed base directory to prevent symlink escapes.
      await verifyRealPathOfExistingPath(path.dirname(filepath), mount);

      // Allow removing symlinks directly (rm removes the link itself, not the target).
      // For non-symlink targets (or symlinks in parent components), enforce real path containment.
      let isSymbolicLink = false;
      try {
        const stats = await fs.lstat(filepath);
        isSymbolicLink = stats.isSymbolicLink();
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
      if (!isSymbolicLink) {
        // Verify resolved path stays within the allowed base directory
        await verifyRealPathOfExistingPath(filepath, mount);
      }
      const rmResult = await serviceHelper.runCommand('rm', { runAsRoot: true, params: ['-rf', filepath] });
      if (rmResult.error) {
        throw rmResult.error;
      }
      const response = messageHelper.createSuccessMessage('File Removed');
      res.json(response);
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    try {
      res.write(serviceHelper.ensureString(errorResponse));
      res.end();
    } catch (e) {
      log.error(e);
    }
  }
}

/**
 * To download a zip folder for a specified directory. Only accessible by admins.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {boolean} authorized False until verified as an admin.
 * @returns {void} Return statement is only used here to interrupt the function and nothing is returned.
 */
async function downloadAppsFolder(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname || '';
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, appname);
    if (authorized) {
      let { folder } = req.params;
      folder = folder || req.query.folder;
      let { component } = req.params;
      component = component || req.query.component;
      if (!folder || !component) {
        const errorResponse = messageHelper.createErrorMessage('folder and component parameters are mandatory');
        res.json(errorResponse);
        return;
      }
      const { mount } = await resolveVolumeTarget(req);
      // Sanitize folder path to prevent directory traversal attacks
      const folderpath = sanitizePath(folder, mount);
      // Verify real path after symlink resolution to prevent symlink escape attacks
      await verifyRealPath(folderpath, mount);
      const zip = archiver('zip');
      const sizeStream = new PassThrough();
      let compressedSize = 0;
      sizeStream.on('data', (chunk) => {
        compressedSize += chunk.length;
      });
      sizeStream.on('end', () => {
        const folderNameArray = folderpath.split('/');
        const folderName = folderNameArray[folderNameArray.length - 1];
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-disposition': `attachment; filename=${folderName}.zip`,
          'Content-Length': compressedSize,
        });
        // Now, pipe the compressed data to the response stream
        const zipFinal = archiver('zip');
        zipFinal.pipe(res);
        zipFinal.directory(folderpath, false);
        zipFinal.finalize();
      });
      zip.pipe(sizeStream);
      zip.directory(folderpath, false);
      zip.finalize();
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    try {
      res.write(serviceHelper.ensureString(errorResponse));
      res.end();
    } catch (e) {
      log.error(e);
    }
  }
}

/**
 * To download a specified file. Only accessible by admins.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void} Return statement is only used here to interrupt the function and nothing is returned.
 */
async function downloadAppsFile(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname || '';
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, appname);
    if (authorized) {
      let { file } = req.params;
      file = file || req.query.file;
      let { component } = req.params;
      component = component || req.query.component;
      if (!file || !component) {
        const errorResponse = messageHelper.createErrorMessage('file and component parameters are mandatory');
        res.json(errorResponse);
        return;
      }
      const { mount } = await resolveVolumeTarget(req);
      // Sanitize file path to prevent directory traversal attacks
      const filepath = sanitizePath(file, mount);
      // Verify real path after symlink resolution to prevent symlink escape attacks
      await verifyRealPath(filepath, mount);
      const chmodResult = await serviceHelper.runCommand('chmod', { runAsRoot: true, params: ['777', filepath] });
      if (chmodResult.error) {
        throw chmodResult.error;
      }
      // beautify name
      const fileNameArray = filepath.split('/');
      const fileName = fileNameArray[fileNameArray.length - 1];
      res.download(filepath, fileName, { dotfiles: 'allow' });
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    try {
      res.write(serviceHelper.ensureString(errorResponse));
      res.end();
    } catch (e) {
      log.error(e);
    }
  }
}

/**
 * To upload files into an app's volume. Only accessible by app owners and above.
 *
 * Lived in IOUtils until the volume work: a request handler in a utilities
 * module, which is what forced a dependency cycle when volume resolution moved
 * to where it belongs. It sits with the other file handlers now.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function fileUpload(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname || '';
    if (!appname) {
      throw new Error('appname parameter is mandatory.');
    }
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, appname);
    if (!authorized) {
      throw new Error('Unauthorized. Access denied.');
    }
    let { filename } = req.params;
    filename = filename || req.query.filename || '';
    let { folder } = req.params;
    folder = folder || req.query.folder || '';
    let { type } = req.params;
    type = type || req.query.type || '';
    if (!type) {
      throw new Error('type parameter is mandatory');
    }

    const { mount } = await resolveVolumeTarget(req);
    const filepath = type === 'backup'
      ? path.join(mount, 'backup', 'upload')
      // Sanitize folder path to prevent directory traversal attacks
      : sanitizePath(folder, mount);
    // Verify resolved path stays within the allowed base directory
    await verifyRealPathOfExistingPath(filepath, mount);

    const options = {
      multiples: true,
      uploadDir: `${filepath}`,
      maxFileSize: 10 * 1024 * 1024 * 1024, // 10gb
      hashAlgorithm: false,
      keepExtensions: true,
      // eslint-disable-next-line no-unused-vars
      filename: (name, ext, part, form) => {
        const { originalFilename } = part;
        return originalFilename;
      },
    };
    await fs.mkdir(filepath, { recursive: true });
    // argv, not a shell string: filepath is derived from request input, and
    // this module's other handlers already run privileged commands this way.
    const chmodResult = await serviceHelper.runCommand('chmod', { runAsRoot: true, params: ['777', filepath] });
    if (chmodResult.error) {
      throw chmodResult.error;
    }
    const form = formidable(options);

    form
      // eslint-disable-next-line no-unused-vars
      .on('fileBegin', (name, file) => {
        // Validate filename to prevent path traversal via filename parameter
        const safeFilename = filename ? validateFilename(filename) : validateFilename(name);
        // eslint-disable-next-line no-param-reassign
        file.filepath = `${filepath}/${safeFilename}`;
      })
      .on('progress', (bytesReceived, bytesExpected) => {
        try {
          res.write(serviceHelper.ensureString([bytesReceived, bytesExpected]));
          if (res.flush) res.flush();
        } catch (error) {
          log.error(error);
        }
      })
      // eslint-disable-next-line no-unused-vars
      .on('file', (name, file) => {
        try {
          res.write(serviceHelper.ensureString(name));
          if (res.flush) res.flush();
        } catch (error) {
          log.error(error);
        }
      })
      .on('aborted', () => {
        log.error(`fileUpload: request aborted by the user for ${appname}`);
      })
      .on('error', (error) => {
        log.error(error);
        const errorResponse = messageHelper.createErrorMessage(
          error.message || error,
          error.name,
          error.code,
        );
        try {
          res.write(serviceHelper.ensureString(errorResponse));
          if (res.flush) res.flush();
        } catch (e) {
          log.error(e);
        }
      })
      .on('end', () => {
        try {
          res.end();
        } catch (error) {
          log.error(error);
        }
      });

    form.parse(req);
  } catch (error) {
    log.error(error);
    if (res) {
      try {
        res.connection.destroy();
      } catch (e) {
        log.error(e);
      }
    }
  }
}

module.exports = {
  createAppsFolder,
  renameAppsObject,
  removeAppsObject,
  downloadAppsFolder,
  downloadAppsFile,
  fileUpload,
};
