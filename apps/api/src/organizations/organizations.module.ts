/**
 * Organization feature module.
 *
 * Exports the service, not the stores. Controllers in other modules that need to
 * know what an organization is call `OrganizationsService`; they never import a
 * persistence implementation (AGENTS.md 3).
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';

import { OrganizationsController } from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';

@Module({
  imports: [AuthModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
