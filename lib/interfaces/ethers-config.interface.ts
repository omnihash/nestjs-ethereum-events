export interface EthersConfig {
  providerUrl: string;
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
  heartbeatInterval?: number;
  pollingInterval?: number;
  keepAliveInterval?: number;
  reconnectionInterval?: number; // Interval for periodic reconnection (ms)
}
