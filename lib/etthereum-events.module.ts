import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { EthereumEventsService } from './ethereum-events.service';
import { EthereumEventsConfigService } from './etthereum-events-config.service';

@Module({
  imports: [ConfigModule.forRoot()],
  providers: [
    EthereumEventsConfigService,
    {
      provide: EthereumEventsService,
      useFactory: (configService: EthereumEventsConfigService) => {
        return new EthereumEventsService(configService.createConfig());
      },
      inject: [EthereumEventsConfigService],
    },
  ],
  exports: [EthereumEventsService],
})
export class EthereumEventsModule {}
