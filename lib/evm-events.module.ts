import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { EvmEventsConfigService } from './evm-events-config.service';
import { EvmEventsService } from './evm-events.service';

@Module({
  imports: [ConfigModule.forRoot()],
  providers: [
    EvmEventsConfigService,
    {
      provide: EvmEventsService,
      useFactory: (configService: EvmEventsConfigService) => {
        return new EvmEventsService(configService.createConfig());
      },
      inject: [EvmEventsConfigService],
    },
  ],
  exports: [EvmEventsService],
})
export class EvmEventsModule {}
