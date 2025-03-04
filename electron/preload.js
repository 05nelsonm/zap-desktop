/**
 * When running `npm run build` or `npm run build-preload`, this file is compiled to
 * `/dist/preload.js` using webpack.
 */
import { ipcRenderer, remote, shell } from 'electron'
import url from 'url'
import fileExists from '@zap/utils/fileExists'
import dirExists from '@zap/utils/dirExists'
import { getAllLocalWallets, getWalletDir, deleteLocalWallet } from '@zap/utils/localWallets'
import lndBinaryPath from '@zap/utils/lndBinaryPath'
import lndGrpcProtoDir from '@zap/utils/lndGrpcProtoDir'
import validateHost from '@zap/utils/validateHost'
import splitHostname from '@zap/utils/splitHostname'
import LndConfig from '@zap/utils/lndConfig'
import { normalizeBackupDir } from './walletBackup/local'

/**
 * List of domains that we will allow users to be redirected to.
 *
 * @type {Array}
 */
const WHITELISTED_DOMAINS = [
  'blockstream.info',
  'coinfaucet.eu',
  'insight.litecore.io',
  'live.blockcypher.com',
  'ln-zap.github.io',
  'testnet.litecore.io',
  'testnet.smartbit.com.au',
  'litecore.io',
  'www.smartbit.com.au',
]

/**
 * List of environment variables that we want to make available.
 *
 * @type {Array}
 */
const WHITELISTED_ENV_VARS = ['DEBUG', 'DEBUG_LEVEL', 'DEBUG_PROD', 'NODE_ENV', 'HOT']

/**
 * openExternal - Open an external web page. Only allow whitelisted domains.
 *
 * @param {string} urlString URL to open
 */
function openExternal(urlString) {
  const parsedUrl = url.parse(urlString)
  if (!parsedUrl.hostname) {
    return
  }
  if (WHITELISTED_DOMAINS.includes(parsedUrl.hostname)) {
    shell.openExternal(urlString)
  }
}

/**
 * openHelpPage - Open the help page in a new browser window.
 */
function openHelpPage() {
  openExternal('https://ln-zap.github.io/zap-tutorials/zap-desktop-getting-started')
}

/**
 * openTestnetFaucet - Open a testnet faucet in a new browser window.
 */
function openTestnetFaucet() {
  openExternal('https://coinfaucet.eu/en/btc-testnet/')
}

/**
 * killNeutrino - Kill Neutrino process.
 *
 * @param  {[string]} signal Signal to send to neutrino process
 * @returns {Promise} Promise that resolves when the neutrino process has been killed
 */
function killNeutrino(signal) {
  return new Promise(resolve => {
    ipcRenderer.once('killNeutrinoSuccess', resolve)
    ipcRenderer.send('killNeutrino', signal)
  })
}

/**
 * generateLndConfigFromWallet - Generates an lnd config object from a wallet config.
 *
 * @param  {object} wallet Wallet config
 * @returns {object}        Lnd config
 */
async function generateLndConfigFromWallet(wallet) {
  // Convert wallet config to lnd config.
  wallet.decoder = wallet.decoder || 'lnd.lndconnect.v1'

  const lndConfig = new LndConfig({
    ...wallet,
    userDataDir: getUserDataDir(),
    binaryPath: lndBinaryPath(),
    protoDir: lndGrpcProtoDir(),
  })

  // Wait for the config to become fully initialized.
  await lndConfig.isReady

  // lndConfig is an LndConfig class instance that contains methods and properties that are promises such as the
  // `isReady` prop used above. We convert this to a plain object so that we can store in Redux and freely pass
  // between the renderer and Web Worker processes without needing to proxy. This also flattens getter method
  // properties to plan props.
  return Object.assign({}, lndConfig)
}

/**
 * getUserDataDir - Get the electron user data directory.
 *
 * @returns {string} Electron user data directory.
 */
function getUserDataDir() {
  return remote.app.getPath('userData')
}

// Provide access to whitelisted environment variables.
window.env = Object.keys(process.env)
  .filter(key => WHITELISTED_ENV_VARS.includes(key))
  .reduce((obj, key) => {
    obj[key] = process.env[key]
    return obj
  }, {})

// Expose a bridging API to by setting an global on `window`.
//
// !CAREFUL! do not expose any functionality or APIs that could compromise the
// user's computer. E.g. don't directly expose core Electron (even IPC) or node.js modules.
window.Zap = {
  openExternal,
  openHelpPage,
  openTestnetFaucet,
  generateLndConfigFromWallet,
  getAllLocalWallets,
  getWalletDir,
  deleteLocalWallet,
  getUserDataDir,
  validateHost,
  fileExists,
  dirExists,
  killNeutrino,
  splitHostname,
  normalizeBackupDir,
}

// Provide access to ipcRenderer.
window.ipcRenderer = ipcRenderer

//Provide access to electron remote
window.showOpenDialog = remote.dialog.showOpenDialog
