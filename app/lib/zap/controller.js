// @flow

import { app, ipcMain, dialog, BrowserWindow } from 'electron'
import pick from 'lodash.pick'
import Store from 'electron-store'
import StateMachine from 'javascript-state-machine'
import { mainLog } from '../utils/log'
import { isLndRunning } from '../lnd/util'

import LndConfig from '../lnd/config'
import Lightning from '../lnd/lightning'
import Neutrino from '../lnd/neutrino'
import WalletUnlocker from '../lnd/walletUnlocker'

type onboardingOptions = {
  type: 'local' | 'custom' | 'btcpayserver',
  host?: string,
  cert?: string,
  macaroon?: string,
  alias?: string,
  autopilot?: boolean
}

const grpcSslCipherSuites = connectionType =>
  (connectionType === 'btcpayserver'
    ? [
        // BTCPay Server serves lnd behind an nginx proxy with a trusted SSL cert from Lets Encrypt.
        // These certs use an RSA TLS cipher suite.
        'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES128-GCM-SHA256'
      ]
    : [
        // Default is ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384
        // https://github.com/grpc/grpc/blob/master/doc/environment_variables.md
        //
        // Current LND cipher suites here:
        // https://github.com/lightningnetwork/lnd/blob/master/lnd.go#L80
        //
        // We order the suites by priority, based on the recommendations provided by SSL Labs here:
        // https://github.com/ssllabs/research/wiki/SSL-and-TLS-Deployment-Best-Practices#23-use-secure-cipher-suites
        'ECDHE-ECDSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384',
        'ECDHE-ECDSA-AES128-CBC-SHA256',
        'ECDHE-ECDSA-CHACHA20-POLY1305'
      ]
  ).join(':')

/**
 * @class ZapController
 *
 * The ZapController class coordinates actions between the the main nand renderer processes.
 */
class ZapController {
  mainWindow: BrowserWindow
  neutrino: Neutrino
  lightning: Lightning
  walletUnlocker: WalletUnlocker
  splashScreenTime: number
  lndConfig: LndConfig
  _fsm: StateMachine

  // Transitions provided by the state machine.
  startOnboarding: any
  startLnd: any
  connectLnd: any
  terminate: any
  is: any

  /**
   * Create a new ZapController instance.
   * @param {BrowserWindow} mainWindow BrowserWindow instance to interact with.
   */
  constructor(mainWindow: BrowserWindow) {
    // Variable to hold the main window instance.
    this.mainWindow = mainWindow

    // Time for the splash screen to remain visible.
    this.splashScreenTime = 500

    // Initialize the state machine.
    this._fsm()

    // Initialise the controler with the current active config.
    this.lndConfig = new LndConfig()
    this.lndConfig.load()
  }

  /**
   * Initialize the controller.
   */
  init() {
    // Load the application into the main window.
    if (process.env.HOT) {
      const port = process.env.PORT || 1212
      this.mainWindow.loadURL(`http://localhost:${port}/dist/index.html`)
    } else {
      this.mainWindow.loadURL(`file://${__dirname}/dist/index.html`)
    }

    // Show the window as soon as the application has finished loading.
    this.mainWindow.webContents.on('did-finish-load', () => {
      this.mainWindow.show()
      this.mainWindow.focus()

      // Show the splash screen and then start onboarding.
      setTimeout(() => this.startOnboarding(), this.splashScreenTime)
    })

    // When the window is closed, just hide it unless we are force closing.
    this.mainWindow.on('close', e => {
      if (process.platform === 'darwin' && !this.mainWindow.forceClose) {
        e.preventDefault()
        this.mainWindow.hide()
      }
    })
  }

  // ------------------------------------
  // FSM Callbacks
  // ------------------------------------

  async onOnboarding(lifecycle: any) {
    mainLog.debug('[FSM] onOnboarding...')

    // Remove any existing IPC listeners so that we can start fresh.
    this._removeIpcListeners()

    // Register IPC listeners so that we can react to instructions coming from the app.
    this._registerIpcListeners()

    // Disconnect any pre-existing lightning wallet connection.
    if (lifecycle.from === 'connected' && this.lightning && this.lightning.can('disconnect')) {
      this.lightning.disconnect()
    }

    // If we are comming from a running state, stop the Neutrino process.
    else if (lifecycle.from === 'running') {
      await this.shutdownNeutrino()
    }

    // Give the grpc connections a chance to be properly closed out.
    return new Promise(resolve => setTimeout(resolve, 200))
  }

  onStartOnboarding() {
    mainLog.debug('[FSM] onStartOnboarding...')

    // Notify the app to start the onboarding process.
    this.sendMessage('startOnboarding', this.lndConfig)
  }

  onBeforeStartLnd() {
    mainLog.debug('[FSM] onBeforeStartLnd...')

    return isLndRunning().then(res => {
      if (res) {
        mainLog.error('lnd already running: %s', res)
        dialog.showMessageBox({
          type: 'error',
          message: 'Unable to start lnd because it is already running.'
        })
        return app.quit()
      }

      mainLog.info('Starting new lnd instance')
      mainLog.info(' > alias:', this.lndConfig.alias)
      mainLog.info(' > autopilot:', this.lndConfig.autopilot)

      return this.startNeutrino()
    })
  }

  onBeforeConnectLnd() {
    mainLog.debug('[FSM] onBeforeConnectLnd...')
    mainLog.info('Connecting to custom lnd instance')
    mainLog.info(' > host:', this.lndConfig.host)
    mainLog.info(' > cert:', this.lndConfig.cert)
    mainLog.info(' > macaroon:', this.lndConfig.macaroon)

    return this.startLightningWallet()
      .then(() => this.sendMessage('finishOnboarding'))
      .catch(e => {
        const errors = {}
        // There was a problem connectig to the host.
        if (e.code === 'LND_GRPC_HOST_ERROR') {
          errors.host = e.message
        }
        // There was a problem accessing loading the ssl cert.
        if (e.code === 'LND_GRPC_CERT_ERROR') {
          errors.cert = e.message
        }
        //  There was a problem accessing loading the macaroon file.
        else if (e.code === 'LND_GRPC_MACAROON_ERROR') {
          errors.macaroon = e.message
        }

        // The `startLightningWallet` call attempts to call the `getInfo` method on the Lightning service in order to
        // verify that it is accessible. If it is not, an error 12 is throw whcih is the gRPC code for `UNIMPLEMENTED`
        // which indicates that the requested operation is not implemented or not supported/enabled in the service.
        // See https://github.com/grpc/grpc-node/blob/master/packages/grpc-native-core/src/constants.js#L129
        if (e.code === 12) {
          errors.host =
            'Unable to connect to host. Please ensure wallet is unlocked before connecting.'
        }

        // Other error codes such as UNAVAILABLE most likely indicate that there is a problem with the host.
        else {
          errors.host = `Unable to connect to host: ${e.details || e.message}`
        }

        // Notify the app of errors.
        this.sendMessage('startLndError', errors)
        throw e
      })
  }

  async onTerminated(lifecycle: any) {
    mainLog.debug('[FSM] onTerminated...')

    // Disconnect from any existing lightning wallet connection.
    if (lifecycle.from === 'connected' && this.lightning && this.lightning.can('disconnect')) {
      this.lightning.disconnect()
    }
    // If we are comming from a running state, stop the Neutrino process.
    else if (lifecycle.from === 'running') {
      await this.shutdownNeutrino()
    }
  }

  onTerminate() {
    mainLog.debug('[FSM] onTerminate...')
    app.quit()
  }

  // ------------------------------------
  // Helpers
  // ------------------------------------

  /**
   * Send a message to the main window.
   * @param  {string} msg message to send.
   * @param  {[type]} data additional data to acompany the message.
   */
  sendMessage(msg: string, data: any) {
    if (this.mainWindow) {
      mainLog.info('Sending message to renderer process: %o', { msg, data })
      this.mainWindow.webContents.send(msg, data)
    } else {
      mainLog.warn('Unable to send message to renderer process (main window not available): %o', {
        msg,
        data
      })
    }
  }

  /**
   * Start the wallet unlocker.
   */
  async startWalletUnlocker() {
    mainLog.info('Establishing connection to Wallet Unlocker gRPC interface...')
    this.walletUnlocker = new WalletUnlocker(this.lndConfig)

    // Connect to the WalletUnlocker interface.
    try {
      await this.walletUnlocker.connect()

      // Listen for all gRPC restful methods and pass to gRPC.
      ipcMain.on('walletUnlocker', (event, { msg, data }) =>
        this.walletUnlocker.registerMethods(event, msg, data)
      )

      // Notify the renderer that the wallet unlocker is active.
      this.sendMessage('walletUnlockerGrpcActive')
    } catch (err) {
      mainLog.warn('Unable to connect to WalletUnlocker gRPC interface: %o', err)
      throw err
    }
  }

  /**
   * Create and subscribe to the Lightning service.
   */
  async startLightningWallet() {
    mainLog.info('Establishing connection to Lightning gRPC interface...')
    this.lightning = new Lightning(this.lndConfig)

    // Connect to the Lightning interface.
    try {
      await this.lightning.connect()

      this.lightning.subscribe(this.mainWindow)

      // Listen for all gRPC restful methods and pass to gRPC.
      ipcMain.on('lnd', (event, { msg, data }) => this.lightning.registerMethods(event, msg, data))

      // Let the renderer know that we are connected.
      this.sendMessage('lightningGrpcActive')
    } catch (err) {
      mainLog.warn('Unable to connect to Lighitnng gRPC interface: %o', err)
      throw err
    }
  }

  /**
  /**
   * Starts the LND node and attach event listeners.
   * @param  {string} alias Alias to assign to the lnd node.
   * @param  {boolean} autopilot True if autopilot should be enabled.
   * @return {Neutrino} Neutrino instance.
   */
  startNeutrino() {
    mainLog.info('Starting Neutrino...')
    this.neutrino = new Neutrino(this.lndConfig)

    this.neutrino.on('error', error => {
      mainLog.error(`Got error from lnd process: ${error})`)
      dialog.showMessageBox({
        type: 'error',
        message: `lnd error: ${error}`
      })
    })

    this.neutrino.on('close', (code, lastError) => {
      mainLog.info(`Lnd process has shut down (code ${code})`)
      if (this.is('running') || this.is('connected')) {
        dialog.showMessageBox({
          type: 'error',
          message: `Lnd has unexpectedly quit: ${lastError}`
        })
        this.terminate()
      }
    })

    this.neutrino.on('wallet-unlocker-grpc-active', () => {
      mainLog.info('Wallet unlocker gRPC active')
      this.startWalletUnlocker()
    })

    this.neutrino.on('lightning-grpc-active', () => {
      mainLog.info('Lightning gRPC active')
      this.startLightningWallet()
    })

    this.neutrino.on('chain-sync-waiting', () => {
      mainLog.info('Neutrino sync waiting')
      this.sendMessage('lndSyncStatus', 'waiting')
    })

    this.neutrino.on('chain-sync-started', () => {
      mainLog.info('Neutrino sync started')
      this.sendMessage('lndSyncStatus', 'in-progress')
    })

    this.neutrino.on('chain-sync-finished', () => {
      mainLog.info('Neutrino sync finished')
      this.sendMessage('lndSyncStatus', 'complete')
    })

    this.neutrino.on('got-current-block-height', height => {
      this.sendMessage('currentBlockHeight', Number(height))
    })

    this.neutrino.on('got-lnd-block-height', height => {
      this.sendMessage('lndBlockHeight', Number(height))
    })

    this.neutrino.on('got-lnd-cfilter-height', height => {
      this.sendMessage('lndCfilterHeight', Number(height))
    })

    this.neutrino.start()
  }

  /**
   * Gracefully shutdown LND.
   */
  async shutdownNeutrino() {
    // We only want to shut down LND if we are running it locally.
    if (this.lndConfig.type !== 'local') {
      return Promise.resolve()
    }

    // Attempt a graceful shutdown if we can.
    if (this.lightning && this.lightning.can('terminate')) {
      mainLog.info('Shutting down Neutrino...')

      return new Promise(resolve => {
        // HACK: Sometimes there are errors during the shutdown process that prevent the daeming from shutting down at
        // all. If we haven't received notification of the process closing within 10 seconds, kill it.
        // See https://github.com/lightningnetwork/lnd/pull/1781
        // See https://github.com/lightningnetwork/lnd/pull/1783
        const shutdownTimeout = setTimeout(() => {
          this.neutrino.removeListener('close', closeHandler)
          if (this.neutrino) {
            mainLog.warn('Graceful shutdown failed to complete within 30 seconds.')
            this.neutrino.kill()
            resolve()
          }
        }, 1000 * 10)

        // HACK: The Lightning.stopDaemon` call returns before lnd has actually fully completed the shutdown process
        // so we add a listener on the close event so that we can wrap things up once the process has been fully closed
        // out.
        const closeHandler = function() {
          mainLog.info('Neutrino shutdown complete.')
          clearTimeout(shutdownTimeout)
          resolve()
        }
        this.neutrino.once('close', closeHandler)

        this.lightning
          .terminate()
          .then(() => mainLog.info('Neutrino Daemon shutdown complete'))
          .catch(err => {
            mainLog.error('Unable to gracefully shutdown LND: %o', err)
            // Kill the process ourselves here to ensure that we don't leave hanging processes.
            if (this.neutrino) {
              this.neutrino.kill()
              resolve()
            }
          })
      })
    }

    // The Lightning service is only active after the wallet has been unlocked and a gRPC connection has been
    // established. In this case, kill the Neutrino process to ensure that we don't leave hanging process.
    // FIXME: This currencly doesn't do a graceful shutdown as LND does not properly handle SIGTERM.
    // See https://github.com/lightningnetwork/lnd/issues/1028
    else if (this.neutrino) {
      this.neutrino.kill()
    }
  }

  finishOnboarding(options: onboardingOptions) {
    mainLog.info('Finishing onboarding')
    // Save the lnd config options that we got from the renderer.
    this.lndConfig = new LndConfig({
      type: options.type,
      currency: 'bitcoin',
      network: 'testnet',
      wallet: 'wallet-1',
      settings: pick(options, LndConfig.SETTINGS_PROPS[options.type])
    })
    this.lndConfig.save()

    // Set as the active config.
    const settings = new Store({ name: 'settings' })
    settings.set('activeConnection', {
      type: this.lndConfig.type,
      currency: this.lndConfig.currency,
      network: this.lndConfig.network,
      wallet: this.lndConfig.wallet
    })
    mainLog.info('Saved active connection as: %o', settings.get('activeConnection'))

    // Set up SSL with the cypher suits that we need based on the connection type.
    process.env.GRPC_SSL_CIPHER_SUITES =
      process.env.GRPC_SSL_CIPHER_SUITES || grpcSslCipherSuites(options.type)

    // If the requested connection type is a local one then start up a new lnd instance.
    // Otherwise attempt to connect to an lnd instance using user supplied connection details.\
    return options.type === 'local' ? this.startLnd() : this.connectLnd()
  }

  /**
   * Add IPC event listeners...
   */
  _registerIpcListeners() {
    ipcMain.on('startLnd', (event, options: onboardingOptions) => this.finishOnboarding(options))
  }

  /**
   * Add IPC event listeners...
   */
  _removeIpcListeners() {
    ipcMain.removeAllListeners('startLnd')
    ipcMain.removeAllListeners('walletUnlocker')
    ipcMain.removeAllListeners('lnd')
  }
}

StateMachine.factory(ZapController, {
  transitions: [
    { name: 'startOnboarding', from: '*', to: 'onboarding' },
    { name: 'startLnd', from: 'onboarding', to: 'running' },
    { name: 'connectLnd', from: 'onboarding', to: 'connected' },
    { name: 'terminate', from: '*', to: 'terminated' }
  ]
})

export default ZapController
