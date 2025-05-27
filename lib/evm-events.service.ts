import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ethers, EventLog, Log } from 'ethers';

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
  private registrationInProgress = false; // Flag to track in-progress registration
  private processingEventAddresses = new Set<string>(); // Track which addresses are being processed

  // Connection management
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private reconnectDelay: number;
  private heartbeatInterval: number;
  private keepAliveInterval: number;
  private reconnectionInterval: number;
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
    this.reconnectionInterval = config.reconnectionInterval || 1_800_000; // 30 minutes default
  }

  /**
   * Initialize module and setup provider connection
   */
  async onModuleInit() {
    await this.initializeProvider();
    this.startHeartbeat();
    this.startKeepAlive();
    this.startPeriodicReconnection();
  }

  /**
   * Clean up resources when module is destroyed
   */
  onModuleDestroy() {
    this.cleanup();
  }

  /**
   * Initialize the Ethereum provider (WebSocket or JsonRpc)
   * Sets up event handlers and tests the connection
   */
  private async initializeProvider() {
    try {
      // Make sure any existing provider is cleaned up
      if (this.provider) {
        try {
          if (
            this.provider instanceof ethers.WebSocketProvider &&
            this.provider.websocket
          ) {
            this.provider.websocket.close();
          }

          if (typeof this.provider.destroy === 'function') {
            await (this.provider as any).destroy();
          }
        } catch (error) {
          this.logger.debug('Error cleaning up old provider:', error);
        }
      }

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
      await this.reregisterAllContracts();
    } catch (error) {
      this.logger.error('Failed to connect to Ethereum provider:', error);
      this.isConnected = false;
      this.handleReconnection();
    }
  }

  /**
   * Set up WebSocket event handlers for connection management
   * Handles close, error, and open events
   */
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

  /**
   * Handle reconnection attempts with exponential backoff
   * Manages reconnection state and retries
   */
  private handleReconnection() {
    // Don't attempt to reconnect if already reconnecting
    if (this.isReconnecting) return;

    this.isReconnecting = true;

    // Check if we've reached the maximum reconnection attempts
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

    // First stop all timers to prevent accessing a destroyed provider
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }

    // If a provider exists, we should first ensure all listeners are removed
    if (this.provider) {
      try {
        // Force cleanup of event listeners before reconnection
        this.provider.removeAllListeners();
      } catch (error) {
        this.logger.warn(
          'Error clearing provider listeners before reconnection:',
          error,
        );
      }
    }

    setTimeout(() => {
      (async () => {
        try {
          // Create a new provider and setup new event handlers
          await this.initializeProvider();

          // Restart the timers with new provider
          this.startHeartbeat();
          this.startKeepAlive();

          this.isReconnecting = false;
        } catch (error) {
          this.logger.error('Reconnection failed:', error);
          this.isReconnecting = false;
          this.handleReconnection();
        }
      })();
    }, this.reconnectDelay * this.reconnectAttempts); // Exponential backoff
  }

  /**
   * Start heartbeat mechanism to monitor connection health
   * Periodically checks connection by getting latest block number
   */
  private startHeartbeat() {
    // Clear existing timer if any
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    this.heartbeatTimer = setInterval(() => {
      void (async () => {
        try {
          // Skip heartbeat if not connected or provider is null
          if (!this.isConnected || !this.provider) return;

          // Simple heartbeat check - get latest block number
          await this.provider.getBlockNumber();
          this.logger.debug('Heartbeat successful');
        } catch (error) {
          // If we get a "provider destroyed" error, don't try to reconnect since
          // it's likely that a reconnection is already in progress
          if (this.isProviderDestroyedError(error)) {
            this.logger.debug(
              'Heartbeat skipped - provider is being destroyed or reconnected',
            );
            return;
          }

          this.logger.warn('Heartbeat failed:', error);
          this.isConnected = false;
          this.handleReconnection();
        }
      })();
    }, this.heartbeatInterval);
  }

  /**
   * Start keep-alive mechanism to prevent connection timeouts
   * Periodically sends lightweight eth_chainId requests
   */
  private startKeepAlive() {
    // Clear existing timer if any
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }

    // Send periodic keep-alive requests to prevent connection timeout
    this.keepAliveTimer = setInterval(() => {
      void (async () => {
        try {
          // Skip keep-alive if not connected or provider is null
          if (!this.isConnected || !this.provider) return;

          // Use a lightweight call to keep connection active
          await this.provider.send('eth_chainId', []);
          this.logger.debug('Keep-alive ping sent');
        } catch (error) {
          // If we get a "provider destroyed" error, don't log a warning
          // as it's likely that a reconnection is already in progress
          if (this.isProviderDestroyedError(error)) {
            this.logger.debug(
              'Keep-alive skipped - provider is being destroyed or reconnected',
            );
            return;
          }

          this.logger.debug('Keep-alive failed:', error);
        }
      })();
    }, this.keepAliveInterval);
  }

  private async reregisterAllContracts() {
    // Check if registration is already in progress to avoid duplicate registrations
    if (this.registrationInProgress) {
      this.logger.warn(
        'Registration already in progress, skipping re-registration',
      );
      return;
    }

    this.registrationInProgress = true;
    this.logger.log('Re-registering all contracts after reconnection...');

    try {
      // Save the list of contracts to re-register
      const contractEntries = Array.from(this.registeredContracts.entries());

      // First completely clear the internal contract tracking state
      this.registeredContracts.clear();

      // Clear existing listeners more aggressively
      const removed = this.unregisterAllContracts();
      this.logger.log(
        `Removed ${removed} event listeners before re-registering contracts`,
      );

      // Small delay to ensure event handlers are properly cleaned up before re-registering
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Re-register all contracts (sequentially to avoid race conditions)
      for (const [address, contractConfig] of contractEntries) {
        if (this.processingEventAddresses.has(address)) {
          this.logger.warn(
            `Contract ${address} is already being processed, skipping re-registration`,
          );
          continue;
        }

        try {
          this.processingEventAddresses.add(address);

          if (contractConfig.eventNames) {
            await this.registerSpecificEvents(
              contractConfig.address,
              contractConfig.abi,
              contractConfig.eventNames,
              contractConfig.callback,
            );
          } else {
            await this.registerContract(
              contractConfig.address,
              contractConfig.abi,
              contractConfig.callback,
            );
          }

          this.logger.debug(`Re-registered contract: ${address}`);
        } catch (error) {
          this.logger.error(
            `Failed to re-register contract ${address}:`,
            error,
          );
        } finally {
          this.processingEventAddresses.delete(address);
        }
      }

      this.logger.log(
        `Completed re-registration of ${contractEntries.length} contracts`,
      );
    } finally {
      this.registrationInProgress = false;
    }
  }

  /**
   * Start periodic reconnection timer
   * Forces a reconnection periodically to maintain fresh state
   * Default is 30 minutes (1,800,000 milliseconds) to reduce chances of duplicate events
   */
  /**
   * Start periodic reconnection timer
   * Forces a reconnection periodically to maintain fresh state
   * Default is 30 minutes (1,800,000 milliseconds) to reduce chances of duplicate events
   */
  private startPeriodicReconnection() {
    // Clear any existing timer
    if (this.reconnectionTimer) {
      clearInterval(this.reconnectionTimer);
      this.reconnectionTimer = undefined;
    }

    // Use the class property that was initialized in the constructor
    // Longer interval helps reduce chances of duplicate events
    this.logger.log(
      `Setting up periodic reconnection every ${this.reconnectionInterval / 60000} minutes`,
    );

    this.reconnectionTimer = setInterval(async () => {
      // Skip reconnection if already in progress or if registration is happening
      if (this.isReconnecting || this.registrationInProgress) {
        this.logger.warn(
          'Reconnection or registration already in progress, skipping periodic reconnection',
        );
        return;
      }

      this.logger.log(
        `Initiating periodic reconnection (every ${this.reconnectionInterval / 60000} minutes)...`,
      );

      // Set state to prevent concurrent reconnections
      this.isReconnecting = true;

      try {
        // First stop all timers to prevent accessing a destroyed provider
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = undefined;
        }

        if (this.keepAliveTimer) {
          clearInterval(this.keepAliveTimer);
          this.keepAliveTimer = undefined;
        }

        // Safely unregister all event listeners
        let count = 0;
        try {
          count = this.unregisterAllContracts();
          this.logger.log(
            `Removed ${count} listeners during periodic reconnection`,
          );
        } catch (error) {
          if (this.isProviderDestroyedError(error)) {
            this.logger.debug(
              'Provider was already destroyed during listener cleanup',
            );
          } else {
            this.logger.error(
              'Error removing listeners during reconnection:',
              error,
            );
          }
        }

        // Allow a small delay for cleanup to complete
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Reset connection state
        this.isConnected = false;
        this.reconnectAttempts = 0;

        // Safely destroy the old provider if possible
        if (this.provider) {
          try {
            if (
              this.provider instanceof ethers.WebSocketProvider &&
              this.provider.websocket
            ) {
              try {
                this.provider.websocket.close();
              } catch (wsError) {
                this.logger.debug('Error closing WebSocket:', wsError);
              }
            }

            if (typeof this.provider.destroy === 'function') {
              await (this.provider as any).destroy();
            }
          } catch (error) {
            if (this.isProviderDestroyedError(error)) {
              this.logger.debug('Provider was already destroyed');
            } else {
              this.logger.debug('Error destroying provider:', error);
            }
          }

          // Set provider to null to ensure no further access attempts
          this.provider = null as any;
        }

        // Small delay before reconnection
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Create a brand new provider connection
        await this.initializeProvider();

        // Restart the timers with new provider
        this.startHeartbeat();
        this.startKeepAlive();

        // Reset reconnecting flag
        this.isReconnecting = false;
      } catch (error) {
        this.logger.error('Error during periodic reconnection:', error);
        this.isReconnecting = false;
        this.handleReconnection();
      }
    }, this.reconnectionInterval);
  }

  /**
   * Register a contract to listen for all its events
   * @param address Contract address
   * @param abi Contract ABI
   * @param callback Callback function that will be called for each event
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
   * Register specific events from a contract
   * @param address Contract address
   * @param abi Contract ABI
   * @param eventNames Array of event names to listen for
   * @param callback Callback function that will be called for each event
   */
  async registerSpecificEvents(
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
    while (!this.provider) {
      this.logger.warn('Provider not initialized yet, waiting...');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

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
        const eventFilter = {
          address: address,
          topics: [eventFragment.fragment.topicHash],
        };

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

        this.provider.on(eventFilter, handler);
        listeners.push((): void => {
          this.provider.off(eventFilter, handler);
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
   * Force a reconnection to the provider
   * Resets connection state and initiates reconnection process
   */
  forceReconnect() {
    this.logger.log('Forcing reconnection...');
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.handleReconnection();
  }

  /**
   * Get current connection and contract registration status
   * @returns Object containing connection state and contract statistics
   */
  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      isReconnecting: this.isReconnecting,
      reconnectAttempts: this.reconnectAttempts,
      registeredContracts: this.registeredContracts.size,
      activeListeners: this.listeners.size,
      reconnectionInterval: this.reconnectionInterval,
    };
  }

  /**
   * Set the reconnection interval and restart the reconnection timer
   * @param intervalMs The new interval in milliseconds (default: 1,800,000 ms / 30 minutes)
   */
  setReconnectionInterval(intervalMs: number = 1_800_000) {
    this.reconnectionInterval = intervalMs;
    this.logger.log(
      `Setting reconnection interval to ${intervalMs / 60000} minutes`,
    );

    // Restart periodic reconnection timer with new interval
    this.startPeriodicReconnection();

    return this.reconnectionInterval;
  }

  /**
   * Unregister a contract and remove all its event listeners
   * @param address Contract address
   * @returns true if contract was registered and successfully removed
   */
  unregisterContract(address: string): boolean {
    const normalized = address.toLowerCase();

    // Remove from active contracts
    const contract = this.contracts.get(normalized);
    if (contract) {
      const listeners = this.listeners.get(normalized) || [];
      for (const off of listeners) {
        try {
          off();
        } catch (error) {
          if (this.isProviderDestroyedError(error)) {
            this.logger.debug(
              `Skipping listener removal for ${normalized} - provider already destroyed`,
            );
          } else {
            this.logger.error(
              `Error removing listener for ${normalized}:`,
              error,
            );
          }
        }
      }
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
   * @returns The number of contracts that were unregistered
   */
  unregisterAllContracts(): number {
    const addresses = Array.from(this.contracts.keys());
    let count = 0;

    // First, clean up individual event listeners from contracts
    for (const address of addresses) {
      const listeners = this.listeners.get(address) || [];
      for (const off of listeners) {
        try {
          off(); // Execute the unregistration callback
          count++;
        } catch (error) {
          // Handle provider destroyed errors gracefully
          if (this.isProviderDestroyedError(error)) {
            this.logger.debug(
              `Skipping listener removal for ${address} - provider already destroyed`,
            );
          } else {
            this.logger.error(`Error removing listener for ${address}:`, error);
          }
        }
      }
    }

    // Explicitly remove all listeners from provider
    if (this.provider) {
      try {
        // First attempt to use removeAllListeners
        this.provider.removeAllListeners();

        // For WebSocketProvider, we need to be more aggressive
        if (this.provider instanceof ethers.WebSocketProvider) {
          try {
            const websocket = (this.provider as any).websocket;
            if (websocket) {
              // Reset websocket event handlers
              if (websocket._eventsCount > 0) {
                websocket.removeAllListeners();
                this.logger.log('Removed all websocket event handlers');
              }
            }
          } catch (wsError) {
            if (this.isProviderDestroyedError(wsError)) {
              this.logger.debug('WebSocket already closed during cleanup');
            } else {
              this.logger.warn(
                'Could not access websocket to clean up handlers:',
                wsError,
              );
            }
          }
        }
      } catch (error) {
        if (this.isProviderDestroyedError(error)) {
          this.logger.debug(
            'Provider already destroyed during listener cleanup',
          );
        } else {
          this.logger.error(
            'Error removing all listeners from provider:',
            error,
          );
        }
      }
    }

    // Clear internal state tracking
    this.contracts.clear();
    this.listeners.clear();

    this.logger.log(
      `Unregistered all active contracts (${count} listeners removed)`,
    );
    return count;
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

  /**
   * Fetch all events for a contract in a block range (batched)
   * @param address Contract address
   * @param abi Contract ABI
   * @param eventNameOrFragment Event filter (e.g. contract.filters.Transfer(...))
   * @param startBlock Start block number (inclusive)
   * @param endBlock End block number (inclusive)
   * @param increment Batch size (default: 1000)
   * @returns Array of events
   */
  async getEventsInBlockRange(
    address: string,
    abi: ethers.InterfaceAbi,
    eventNameOrFragment: ethers.ContractEventName,
    startBlock: number,
    endBlock: number,
    increment = 1000,
  ): Promise<(Log | EventLog)[]> {
    while (!this.provider) {
      this.logger.warn('Provider not initialized yet, waiting...');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const contract = new ethers.Contract(address, abi, this.provider);
    const allEvents: Log[] = [];
    for (let i = startBlock; i <= endBlock; i += increment) {
      const fromBlock = i;
      const toBlock = Math.min(i + increment - 1, endBlock);
      try {
        this.logger.log(
          `Querying events from block ${fromBlock} to ${toBlock}`,
        );
        // Use event name or fragment and optional indexed args
        // If eventNameOrFragment is null or '*', fetch all events
        const events = await contract.queryFilter(
          eventNameOrFragment,
          fromBlock,
          toBlock,
        );

        // Filter to only EventLog instances (decoded events)
        const eventLogs = events.filter(
          (event): event is Log => event instanceof Log,
        );

        allEvents.push(...eventLogs);
      } catch (err) {
        this.logger.error(
          `Failed to fetch events for blocks ${fromBlock}-${toBlock}:`,
          err,
        );
        return [];
      }
    }
    return allEvents;
  }

  /**
   * Helper method to detect if an error is related to a destroyed provider
   * @param error Any error object to check
   * @returns true if the error is a provider destroyed error
   */
  private isProviderDestroyedError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    // Check for the standard error message
    if (error.message?.includes('provider destroyed')) return true;

    // Check for specific error code
    const errorWithCode = error as { code?: string };
    if (errorWithCode.code === 'UNSUPPORTED_OPERATION') return true;

    // Check for short message (ethers.js specific)
    const errorWithShortMessage = error as { shortMessage?: string };
    if (errorWithShortMessage.shortMessage?.includes('provider destroyed'))
      return true;

    return false;
  }
}
