import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { CustomRolesController } from './custom-roles.controller.js';
import { CustomRoleService } from './custom-role.service.js';

@Module({
  imports: [AuthModule],
  controllers: [CustomRolesController],
  providers: [CustomRoleService],
  exports: [CustomRoleService],
})
export class CustomRolesModule {}