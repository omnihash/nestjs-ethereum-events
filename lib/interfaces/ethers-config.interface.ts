export interface EthersConfig {
  providerUrl: string;
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
  heartbeatInterval?: number;
  pollingInterval?: number;
  keepAliveInterval?: number;
}
