import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EthersConfig } from './interfaces/ethers-config.interface';

@Injectable()
export class EvmEventsConfigService {
  constructor(private readonly configService: ConfigService) {}

  createConfig(): EthersConfig {
    // The radix is the base of the numeral system to be used for parsing numbers.
    // In parseInt(str, radix), radix 10 means decimal (base 10).
    return {
      providerUrl:
        this.configService.get('EVM_RPC_PROVIDER_URL') ??
        'http://localhost:8545',
      maxReconnectAttempts: parseInt(
        this.configService.get('EVM_MAX_RECONNECT_ATTEMPTS') ?? '20',
      ),
      reconnectDelay: parseInt(
        this.configService.get('EVM_RECONNECT_DELAY') ?? '3000',
      ),
      heartbeatInterval: parseInt(
        this.configService.get('EVM_HEARTBEAT_INTERVAL') ?? '60000',
      ),
      pollingInterval: parseInt(
        this.configService.get('EVM_POLLING_INTERVAL') ?? '5000',
      ),
      keepAliveInterval: parseInt(
        this.configService.get('EVM_KEEP_ALIVE_INTERVAL') ?? '120000',
      ),
      reconnectionInterval: parseInt(
        this.configService.get('EVM_RECONNECTION_INTERVAL') ?? '120000',
      ),
    };
  }
}
