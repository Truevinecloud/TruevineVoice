import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { CONTACT_STORE } from './contact.store.js';
import { ContactsController } from './contacts.controller.js';
import { ContactsService } from './contacts.service.js';
import { PrismaContactStore } from './prisma-contact.store.js';
@Module({
  imports: [AuthModule, InfrastructureModule],
  controllers: [ContactsController],
  providers: [ContactsService, { provide: CONTACT_STORE, useClass: PrismaContactStore }],
  exports: [ContactsService],
})
export class ContactsModule {}
