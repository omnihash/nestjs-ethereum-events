import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ethers } from 'ethers';

import { isString } from 'class-validator';
import { EthersConfig } from './interfaces/ethers-config.interface';
import { RegisteredContract } from './interfaces/registered-contract.interface';

@Injectable()
export class EvmEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EvmEventsService.name);
  private provider!: ethers.JsonRpcProvider | ethers.WebSocketProvider;
  private contracts = new Map<string, ethers.Contract>();
  private listeners = new Map<string, Array<() => void>>();
  private registeredContracts = new Map<string, RegisteredContract>();

  // Connection management
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private reconnectDelay: number;
  private heartbeatInterval: number;
  private keepAliveInterval: number;
  private heartbeatTimer?: NodeJS.Timeout;
  private keepAliveTimer?: NodeJS.Timeout;
  private reconnectionTimer?: NodeJS.Timeout;
  private isConnected = false;
  private isReconnecting = false;

  constructor(private readonly config: EthersConfig) {
    this.maxReconnectAttempts = config.maxReconnectAttempts || 10;
    this.reconnectDelay = config.reconnectDelay || 5000;
    this.heartbeatInterval = config.heartbeatInterval || 30000; // 30 seconds
    this.keepAliveInterval = config.keepAliveInterval || 15000; // 15 seconds
  }

  async onModuleInit() {
    await this.initializeProvider();
    this.startHeartbeat();
    this.startKeepAlive();
    this.startPeriodicReconnection();
  }

  onModuleDestroy() {
    this.cleanup();
  }

  private async initializeProvider() {
    try {
      // Determine provider type based on URL
      if (
        this.config.providerUrl.startsWith('ws://') ||
        this.config.providerUrl.startsWith('wss://')
      ) {
        this.provider = new ethers.WebSocketProvider(this.config.providerUrl);
        this.setupWebSocketEventHandlers();
      } else {
        this.provider = new ethers.JsonRpcProvider(this.config.providerUrl);
        isString(this.config.pollingInterval);
        this.provider.pollingInterval = this.config.pollingInterval
          ? isString(this.config.pollingInterval)
            ? parseInt(this.config.pollingInterval)
            : this.config.pollingInterval
          : 5_000;
      }

      // Test connection
      await this.provider.getNetwork();
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.logger.log('Connected to Ethereum provider');

      // Re-register all contracts after reconnection
      this.reregisterAllContracts();
    } catch (error) {
      this.logger.error('Failed to connect to Ethereum provider:', error);
      this.isConnected = false;
      this.handleReconnection();
    }
  }

  private setupWebSocketEventHandlers() {
    if (this.provider instanceof ethers.WebSocketProvider) {
      // Handle WebSocket close
      // Listen for provider-level events instead of accessing internal websocket
      this.provider.on('close', (code: number, reason: string) => {
        this.logger.warn(`WebSocket closed. Code: ${code}, Reason: ${reason}`);
        this.isConnected = false;
        this.handleReconnection();
      });

      this.provider.on('error', (error: Error) => {
        this.logger.error('WebSocket error:', error);
        this.isConnected = false;
        this.handleReconnection();
      });

      this.provider.on('open', () => {
        this.logger.log('WebSocket connection opened');
        this.isConnected = true;
        this.reconnectAttempts = 0;
      });

      // ethers.js WebSocketProvider does not expose ping/pong events publicly,
      // so skip this block or implement keep-alive via heartbeat elsewhere.
    }
  }

  private handleReconnection() {
    if (this.isReconnecting) return;

    this.isReconnecting = true;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(
        'Max reconnection attempts reached. Stopping reconnection.',
      );
      this.isReconnecting = false;
      return;
    }

    this.reconnectAttempts++;
    this.logger.log(
      `Attempting to reconnect... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
    );

    setTimeout(() => {
      (async () => {
        try {
          await this.initializeProvider();
          this.isReconnecting = false;
        } catch (error) {
          this.logger.error('Reconnection failed:', error);
          this.isReconnecting = false;
          this.handleReconnection();
        }
      })();
    }, this.reconnectDelay * this.reconnectAttempts); // Exponential backoff
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      void (async () => {
        try {
          if (!this.isConnected) return;

          // Simple heartbeat check - get latest block number
          await this.provider.getBlockNumber();
          this.logger.debug('Heartbeat successful');
        } catch (error) {
          this.logger.warn('Heartbeat failed:', error);
          this.isConnected = false;
          this.handleReconnection();
        }
      })();
    }, this.heartbeatInterval);
  }

  private startKeepAlive() {
    // Send periodic keep-alive requests to prevent connection timeout
    this.keepAliveTimer = setInterval(() => {
      void (async () => {
        try {
          if (!this.isConnected) return;

          // Use a lightweight call to keep connection active
          await this.provider.send('eth_chainId', []);
          this.logger.debug('Keep-alive ping sent');
        } catch (error) {
          this.logger.warn('Keep-alive failed:', error);
        }
      })();
    }, this.keepAliveInterval);
  }

  private reregisterAllContracts() {
    this.logger.log('Re-registering all contracts after reconnection...');

    // Clear existing listeners
    this.unregisterAllContracts();

    // Re-register all contracts
    for (const [address, contractConfig] of this.registeredContracts) {
      try {
        if (contractConfig.eventNames) {
          this.registerSpecificEvents(
            contractConfig.address,
            contractConfig.abi,
            contractConfig.eventNames,
            contractConfig.callback,
          );
        } else {
          this.registerContract(
            contractConfig.address,
            contractConfig.abi,
            contractConfig.callback,
          );
        }
        this.logger.log(`Re-registered contract: ${address}`);
      } catch (error) {
        this.logger.error(`Failed to re-register contract ${address}:`, error);
      }
    }
  }

  private startPeriodicReconnection() {
    // Clear any existing timer
    if (this.reconnectionTimer) {
      clearInterval(this.reconnectionTimer);
    }

    // Set up reconnection every 5 minutes (300000 milliseconds)
    this.reconnectionTimer = setInterval(() => {
      this.logger.log('Initiating periodic reconnection...');
      this.isConnected = false;
      this.reconnectAttempts = 0;
      this.handleReconnection();
    }, 300000);
  }

  /**
   * Register a contract with automatic reconnection support
   */
  async registerContract(
    address: string,
    abi: ethers.InterfaceAbi,
    callback: (
      parsedLog: ethers.LogDescription | null,
      rawLog: ethers.Log,
      eventName: string,
    ) => Promise<void> | void,
  ) {
    const normalized = address.toLowerCase();

    // Wait until provider is initialized
    while (!this.provider) {
      this.logger.warn('Provider not initialized yet, waiting...');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // Store contract config for re-registration
    this.registeredContracts.set(normalized, {
      address,
      abi,
      callback,
    });

    return this.registerContractInternal(address, abi, callback);
  }

  /**
   * Register specific events with automatic reconnection support
   */
  registerSpecificEvents(
    address: string,
    abi: ethers.InterfaceAbi,
    eventNames: string[],
    callback: (
      parsedLog: ethers.LogDescription | null,
      rawLog: ethers.Log,
      eventName: string,
    ) => void | Promise<void>,
  ) {
    const normalized = address.toLowerCase();

    // Store contract config for re-registration
    this.registeredContracts.set(normalized, {
      address,
      abi,
      callback,
      eventNames,
    });

    return this.registerSpecificEventsInternal(
      address,
      abi,
      eventNames,
      callback,
    );
  }

  private registerContractInternal(
    address: string,
    abi: ethers.InterfaceAbi,
    callback: (
      parsedLog: ethers.LogDescription | null,
      rawLog: ethers.Log,
      eventName: string,
    ) => void | Promise<void>,
  ) {
    const normalized = address.toLowerCase();

    if (this.contracts.has(normalized)) {
      this.unregisterContract(address);
    }

    try {
      // Create filter for all events from this contract
      const filter = { address: address };
      const contract = new ethers.Contract(address, abi, this.provider);
      this.contracts.set(normalized, contract);

      const handler = async (log: ethers.Log) => {
        try {
          const parsedLog = contract.interface.parseLog({
            topics: log.topics,
            data: log.data,
          });

          if (parsedLog) {
            await callback(parsedLog, log, parsedLog.name);
          } else {
            await callback(null, log, 'unknown');
          }
        } catch (err) {
          this.logger.error(`Failed to parse log from ${address}:`, err);
          await callback(null, log, 'error');
        }
      };

      this.provider.on(filter, handler);

      const listeners = this.listeners.get(normalized) || [];
      listeners.push((): void => {
        this.provider.off(filter, handler);
      });
      this.listeners.set(normalized, listeners);

      this.logger.log(`Registered contract listener: ${address}`);
    } catch (error) {
      this.logger.error(`Failed to register contract ${address}:`, error);
      throw error;
    }
  }

  private registerSpecificEventsInternal(
    address: string,
    abi: ethers.InterfaceAbi,
    eventNames: string[],
    callback: (
      parsedLog: ethers.LogDescription | null,
      rawLog: ethers.Log,
      eventName: string,
    ) => void | Promise<void>,
  ) {
    const normalized = address.toLowerCase();

    if (this.contracts.has(normalized)) {
      this.unregisterContract(address);
    }

    try {
      const contract = new ethers.Contract(address, abi, this.provider);
      this.contracts.set(normalized, contract);
      const listeners: Array<() => void> = [];

      for (const eventName of eventNames) {
        // ethers v6: getEventTopic is deprecated, use getEvent + topicHash
        const eventFragment = contract.getEvent(eventName);
        const eventTopic = eventFragment.fragment.topicHash;

        const handler = async (log: ethers.Log) => {
          try {
            const parsedLog = contract.interface.parseLog({
              topics: log.topics,
              data: log.data,
            });

            if (parsedLog && parsedLog.name === eventName) {
              await callback(parsedLog, log, eventName);
            }
          } catch (err) {
            this.logger.error(
              `Failed to parse ${eventName} from ${address}:`,
              err,
            );
            await callback(null, log, 'error');
          }
        };

        this.provider.on(eventTopic, handler);
        listeners.push((): void => {
          this.provider.off(eventTopic, handler);
        });
      }

      this.listeners.set(normalized, listeners);
      this.logger.log(
        `Registered specific events for ${address}: ${eventNames.join(', ')}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to register specific events for ${address}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Manually trigger reconnection
   */
  forceReconnect() {
    this.logger.log('Forcing reconnection...');
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.handleReconnection();
  }

  /**
   * Get connection status
   */
  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      isReconnecting: this.isReconnecting,
      reconnectAttempts: this.reconnectAttempts,
      registeredContracts: this.registeredContracts.size,
      activeListeners: this.listeners.size,
    };
  }

  /**
   * Unregister contract
   */
  unregisterContract(address: string): boolean {
    const normalized = address.toLowerCase();

    // Remove from active contracts
    const contract = this.contracts.get(normalized);
    if (contract) {
      const listeners = this.listeners.get(normalized) || [];
      listeners.forEach((off) => off());
      this.contracts.delete(normalized);
      this.listeners.delete(normalized);
    }

    // Remove from registered contracts (prevents re-registration)
    const wasRegistered = this.registeredContracts.delete(normalized);

    if (wasRegistered) {
      this.logger.log(`Unregistered contract: ${address}`);
    }

    return wasRegistered;
  }

  /**
   * Unregister all contracts
   */
  unregisterAllContracts(): void {
    const addresses = Array.from(this.contracts.keys());
    addresses.forEach((address) => {
      const listeners = this.listeners.get(address) || [];
      listeners.forEach((off) => off());
    });

    this.contracts.clear();
    this.listeners.clear();
    this.logger.log('Unregistered all active contracts');
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
    }

    if (this.reconnectionTimer) {
      clearInterval(this.reconnectionTimer);
    }

    this.unregisterAllContracts();
    this.registeredContracts.clear();

    if (this.provider instanceof ethers.WebSocketProvider) {
      this.provider.websocket.close();
    }

    this.logger.log('PersistentEthersListenerService cleaned up');
  }
}
