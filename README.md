# @omnihash/nestjs-evm-events

A NestJS module for robust Ethereum event listening and contract interaction using [ethers.js](https://docs.ethers.org/).

**Note:** This module is actively in development, please **do not** use in production.

---

## Installation

```bash
npm install @omnihash/nestjs-evm-events ethers
# or
yarn add @omnihash/nestjs-evm-events ethers
```

---

## Usage

### 1. Configure Environment

Create a `.env` file in your project root:

```env
EVM_JSON_PROVIDER_URL=https://eth-mainnet.g.alchemy.com/v2/your-api-key
EVM_MAX_RECONNECT_ATTEMPTS=10
EVM_RECONNECT_DELAY=5000
EVM_HEARTBEAT_INTERVAL=30000
EVM_POLLING_INTERVAL=4000
EVM_KEEP_ALIVE_INTERVAL=15000
```

You can also see `.env.example` for all options.

---

### 2. Example Usage

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EvmEventsModule, EvmEventsService } from '@omnihash/nestjs-evm-events';
import { AppController } from './app.controller';
import { AppService } from './app.service';

const ERC20_ADDRESS = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

@Module({
  imports: [EvmEventsModule, ConfigModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {
  constructor(private readonly evmEventsService: EvmEventsService) {
    void this.run();
  }

  async run() {
    await this.evmEventsService.registerContract(
      ERC20_ADDRESS,
      ERC20_ABI,
      (event) => {
        // Do stuff here
        console.log('Event received:', event);
      },
    );
  }
}
```

---

## API

### EthersModule

- `EvmEventsModule`  
  Loads configuration from `.env` and sets up the listener service.

### EthersListenerService

- `registerContract(address: string, abi: ethers.InterfaceAbi, callback?: (event) => void): void`  
  Register a contract to listen for all its events.

- `getEventsInBlockRange(address: string, abi: ethers.InterfaceAbi, eventNameOrFragment: ethers.ContractEventName, startBlock: number, endBlock: number, increment = 1000): Promise<ethers.EventLog[]>`  
  Fetch all events for a contract in a block range with automatic batching.

### Example: Fetching Historical Events

```typescript
import { Injectable } from '@nestjs/common';
import { EvmEventsService } from '@omnihash/nestjs-evm-events';

@Injectable()
export class YourService {
  constructor(private readonly evmEventsService: EvmEventsService) {}

  async fetchTransferEvents() {
    const ERC20_ADDRESS = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
    const ERC20_ABI = [
      'event Transfer(address indexed from, address indexed to, uint256 value)',
    ];

    // Fetch all Transfer events from the last 1000 blocks
    const currentBlock = await yourJsonProvider.getBlockNumber();
    const events = await this.evmEventsService.getEventsInBlockRange(
      ERC20_ADDRESS,
      ERC20_ABI,
      '*', // '*' for all events or event name
      currentBlock - 1000, // start block
      currentBlock, // end block
      100, // batch size (optional)
    );

    for (const event of events) {
      console.log('Event:', event);
    }
  }
}
```

---

## License

MIT
