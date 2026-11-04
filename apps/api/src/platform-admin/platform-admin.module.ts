import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { PlatformAdminController } from './platform-admin.controller.js';
import { PlatformAdminService } from './platform-admin.service.js';
import { PrismaPlatformAdminStore } from './prisma-platform-admin.store.js';
import { PLATFORM_ADMIN_STORE } from './tokens.js';

@Module({
  imports: [AuthModule, InfrastructureModule],
  controllers: [PlatformAdminController],
  providers: [
    PlatformAdminService,
    { provide: PLATFORM_ADMIN_STORE, useClass: PrismaPlatformAdminStore },
  ],
})
export class PlatformAdminModule {}
