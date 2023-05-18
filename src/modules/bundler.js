const fse = require('fs-extra');
const fs = require('fs');
const archiver = require('archiver');
const asar = require('asar');
const config = require('./config');
const constants = require('../constants');
const utils = require('../utils');
const peLibraryCjs = require('pe-library/cjs');
const reseditCjs = require('resedit/cjs');

async function createAsarFile() {
    utils.log(`Generating ${constants.files.resourceFile}...`);
    const configObj = config.get();
    const resourcesDir = utils.trimPath(configObj.cli.resourcesPath);
    const extensionsDir = utils.trimPath(configObj.cli.extensionsPath);
    const clientLibrary = configObj.cli.clientLibrary ? utils.trimPath(configObj.cli.clientLibrary)
                            : null;
    const icon = utils.trimPath(configObj.modes.window.icon);
    const binaryName = configObj.cli.binaryName;

    fs.mkdirSync(`.tmp`, { recursive: true });
    await fse.copy(`./${resourcesDir}`, `.tmp/${resourcesDir}`, {overwrite: true});

    if(extensionsDir && fs.existsSync(extensionsDir)) {
        await fse.copy(`./${extensionsDir}`, `dist/${binaryName}/${extensionsDir}`, {overwrite: true});
    }

    await fse.copy(`${constants.files.configFile}`, `.tmp/${constants.files.configFile}`, {overwrite: true});
    if(clientLibrary) {
        await fse.copy(`./${clientLibrary}`, `.tmp/${clientLibrary}`, {overwrite: true});
    }
    await fse.copy(`./${icon}`, `.tmp/${icon}`, {overwrite: true});

    await asar.createPackage('.tmp', `dist/${binaryName}/${constants.files.resourceFile}`);
}

/**
 * Add metadata info to Win32 PE binary
 */
async function setBinaryMetadata(sourceFilename, destFilename) {

    utils.log(`Setting resources in Win32 binary --> ${destFilename}...`);

    // load and parse data
    const DEFAULT_LANGID = 1033;
    const data = fs.readFileSync(sourceFilename);
    const resedit = await reseditCjs.load();
    const peLibrary = await peLibraryCjs.load();

    // load original binary
    const exe = peLibrary.NtExecutable.from(data);
    const res = peLibrary.NtExecutableResource.from(exe);

    // get binary metadata from neutralino configFile
    const appConfig = config.get();
    const binaryMetadata = appConfig.cli?.binaryMetadata ?? {};
    binaryMetadata.version = (appConfig.version ?? '0.0.0.0').split('.').map(v => +v);

    // set icon
    if(binaryMetadata.icon) {
        // test for .ico extension
        if(!binaryMetadata.icon.toLowerCase().endsWith('.ico')) {
            utils.warn(`${binaryMetadata.icon} is not a valid Win32 ico, it must be in '*.ico' format`);
        }
        else {
            // load icon data from file (making its path relative)
            const iconFile = resedit.Data.IconFile.from(fs.readFileSync(`./${binaryMetadata.icon}`));
            resedit.Resource.IconGroupEntry.replaceIconsForResource(
                res.entries,
                0,
                DEFAULT_LANGID,
                iconFile.icons.map((item) => item.data)
            );
        }
    }

    // version info
    const vi = resedit.Resource.VersionInfo.createEmpty();

    // set versions
    vi.setProductVersion(...binaryMetadata.version);
    vi.setFileVersion(...binaryMetadata.version);
    vi.setStringValues(
        { lang: DEFAULT_LANGID, codepage: 1200 },
        {
            ProductName: binaryMetadata.name ?? '',
            FileDescription: binaryMetadata.description ?? '',
            LegalCopyright: binaryMetadata.copyright ?? '',
        }
    );
    vi.outputToResourceEntries(res.entries);

    // write destination binary
    res.outputResource(exe);
    fs.writeFileSync(destFilename, Buffer.from(exe.generate()));
}

module.exports.bundleApp = async (isRelease, copyStorage) => {
    let configObj = config.get();
    let binaryName = configObj.cli.binaryName;
    try {
        await createAsarFile();
        utils.log('Copying binaries...');

        for(let platform in constants.files.binaries) {
            for(let arch in constants.files.binaries[platform]) {
                let originalBinaryFile = constants.files.binaries[platform][arch];
                let destinationBinaryFile = originalBinaryFile.replace('neutralino', binaryName);
                if(fse.existsSync(`bin/${originalBinaryFile}`)) {
                    let originalFullname = `bin/${originalBinaryFile}`;
                    let destinationFullname = `dist/${binaryName}/${destinationBinaryFile}`;
                    // Win32 binaries support PE resources
                    if(platform === 'win32') {
                        await setBinaryMetadata(originalFullname, destinationFullname);
                    }
                    else {
                        fse.copySync(originalFullname, destinationFullname);
                    }
                }
            }
        }

        for(let dependency of constants.files.dependencies) {
            fse.copySync(`bin/${dependency}`,`dist/${binaryName}/${dependency}`);
        }

        if(copyStorage) {
            utils.log('Copying storage data...');
            try {
                fse.copySync('.storage',`dist/${binaryName}/.storage`);
            }
            catch(err) {
                utils.error('Unable to copy storage data from the .storage directory. Please check if the directory exists');
                process.exit(1);
            }
        }

        if (isRelease) {
            utils.log('Making app bundle ZIP file...');
            let output = fs.createWriteStream(`dist/${binaryName}-release.zip`);
            let archive = archiver('zip', { zlib: { level: 9 } });
            archive.pipe(output);
            archive.directory(`dist/${binaryName}`, false);
            await archive.finalize();
        }
        utils.clearCache();
    }
    catch (e) {
        utils.error(e);
    }
}
