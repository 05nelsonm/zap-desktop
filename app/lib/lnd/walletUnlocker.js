// @flow

import grpc from 'grpc'
import { loadSync } from '@grpc/proto-loader'
import StateMachine from 'javascript-state-machine'
import LndConfig from './config'
import { getDeadline, validateHost, createSslCreds, createMacaroonCreds } from './util'
import methods from './walletUnlockerMethods'
import { mainLog } from '../utils/log'

/**
 * Creates an LND grpc client lightning service.
 * @returns {WalletUnlocker}
 */
class WalletUnlocker {
  service: any
  lndConfig: LndConfig
  _fsm: StateMachine

  // Transitions provided by the state machine.
  connect: any
  disconnect: any
  terminate: any
  is: any
  can: any
  state: string

  constructor(lndConfig: LndConfig) {
    this.service = null
    this.lndConfig = lndConfig

    // Initialize the state machine.
    this._fsm()
  }

  // ------------------------------------
  // FSM Callbacks
  // ------------------------------------

  /**
   * Connect to the gRPC interface and verify it is functional.
   * @return {Promise<rpc.lnrpc.WalletUnlocker>}
   */
  async onBeforeConnect() {
    mainLog.info('Connecting to WalletUnlocker gRPC service')
    const { rpcProtoPath, host, cert, macaroon } = this.lndConfig

    // Verify that the host is valid before creating a gRPC client that is connected to it.
    return await validateHost(host).then(async () => {
      // Load the gRPC proto file.
      // The following options object closely approximates the existing behavior of grpc.load.
      // See https://github.com/grpc/grpc-node/blob/master/packages/grpc-protobufjs/README.md
      const options = {
        keepCase: true,
        longs: Number,
        enums: String,
        defaults: true,
        oneofs: true
      }
      const packageDefinition = loadSync(rpcProtoPath, options)

      // Load gRPC package definition as a gRPC object hierarchy.
      const rpc = grpc.loadPackageDefinition(packageDefinition)

      // Create ssl and macaroon credentials to use with the gRPC client.
      const [sslCreds, macaroonCreds] = await Promise.all([
        createSslCreds(cert),
        createMacaroonCreds(macaroon)
      ])
      const credentials = grpc.credentials.combineChannelCredentials(sslCreds, macaroonCreds)

      // Create a new gRPC client instance.
      this.service = new rpc.lnrpc.WalletUnlocker(host, credentials)

      // Wait for the gRPC connection to be established.
      return new Promise((resolve, reject) => {
        this.service.waitForReady(getDeadline(2), err => {
          if (err) {
            this.service.close()
            return reject(err)
          }
          return resolve()
        })
      })
    })
  }

  /**
   * Discomnnect the gRPC service.
   */
  onBeforeDisconnect() {
    mainLog.info('Disconnecting from WalletUnlocker gRPC service')
    if (this.service) {
      this.service.close()
    }
  }

  // ------------------------------------
  // Helpers
  // ------------------------------------

  /**
   * Hook up lnd restful methods.
   */
  registerMethods(event: Event, msg: string, data: any) {
    return methods(this.service, mainLog, event, msg, data, this.lndConfig)
  }
}

StateMachine.factory(WalletUnlocker, {
  init: 'ready',
  transitions: [
    { name: 'connect', from: 'ready', to: 'connected' },
    { name: 'disconnect', from: 'connected', to: 'ready' }
  ]
})

export default WalletUnlocker
