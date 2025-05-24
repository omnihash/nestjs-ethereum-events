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
ETHERS_PROVIDER_URL=https://eth-mainnet.g.alchemy.com/v2/your-api-key
ETHERS_MAX_RECONNECT_ATTEMPTS=10
ETHERS_RECONNECT_DELAY=5000
ETHERS_HEARTBEAT_INTERVAL=30000
ETHERS_POLLING_INTERVAL=4000
ETHERS_KEEP_ALIVE_INTERVAL=15000
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

---

## License

MIT
