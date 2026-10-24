import {
  Body,
  Delete,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentOrganization,
  CurrentPrincipal,
  RequireAcceptedTerms,
  RequireOrganizationPermission,
} from '../auth/permission.decorators.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { OrganizationGuard } from '../auth/organization.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ContactsService } from './contacts.service.js';

const Protected = [SessionGuard, OrganizationGuard, CsrfGuard];
@Controller('organizations/:organizationId')
export class ContactsController {
  constructor(@Inject(ContactsService) private readonly contacts: ContactsService) {}
  @Get('contacts')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('contact:read')
  list(@CurrentOrganization() o: { organizationId: string }, @Query() q: Record<string, unknown>) {
    return this.contacts.listContacts(o.organizationId, q);
  }
  @Post('contacts')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('contact:create')
  create(
    @CurrentOrganization() o: { organizationId: string },
    @CurrentPrincipal() p: { userId: string },
    @Body() b: unknown,
  ) {
    return this.contacts.createContact(o.organizationId, p.userId, b);
  }
  @Patch('contacts/:contactId')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('contact:update')
  update(
    @CurrentOrganization() o: { organizationId: string },
    @CurrentPrincipal() p: { userId: string },
    @Param('contactId') id: string,
    @Body() b: unknown,
  ) {
    return this.contacts.updateContact(o.organizationId, p.userId, id, b);
  }
  @Delete('contacts/:contactId')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('contact:update')
  deleteContact(
    @CurrentOrganization() o: { organizationId: string },
    @CurrentPrincipal() p: { userId: string },
    @Param('contactId') id: string,
  ) {
    return this.contacts.deleteContact(o.organizationId, p.userId, id);
  }
  @Post('contacts/:contactId/voice-consent')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('contact:update')
  recordVoiceConsent(
    @CurrentOrganization() o: { organizationId: string },
    @CurrentPrincipal() p: { userId: string },
    @Param('contactId') id: string,
    @Body() b: unknown,
  ) {
    return this.contacts.recordVoiceConsent(o.organizationId, p.userId, id, b);
  }
  @Post('contacts/:contactId/suppress')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('contact:update')
  suppress(
    @CurrentOrganization() o: { organizationId: string },
    @CurrentPrincipal() p: { userId: string },
    @Param('contactId') id: string,
    @Body() b: unknown,
  ) {
    return this.contacts.suppressContact(o.organizationId, p.userId, id, b);
  }
  @Get('contact-groups')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('contact:read')
  groups(@CurrentOrganization() o: { organizationId: string }) {
    return this.contacts.listGroups(o.organizationId);
  }
  @Post('contact-groups')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('contact:create')
  createGroup(
    @CurrentOrganization() o: { organizationId: string },
    @CurrentPrincipal() p: { userId: string },
    @Body() b: unknown,
  ) {
    return this.contacts.createGroup(o.organizationId, p.userId, b);
  }
  @Post('contact-imports')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('contact:import')
  startImport(
    @CurrentOrganization() o: { organizationId: string },
    @CurrentPrincipal() p: { userId: string },
    @Body() b: unknown,
  ) {
    return this.contacts.startImport(o.organizationId, p.userId, b);
  }
  @Post('contact-imports/:importId/batches')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('contact:import')
  batch(
    @CurrentOrganization() o: { organizationId: string },
    @CurrentPrincipal() p: { userId: string },
    @Param('importId') id: string,
    @Body() b: unknown,
  ) {
    return this.contacts.processImportBatch(o.organizationId, p.userId, id, b);
  }
  @Post('contact-imports/:importId/complete')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('contact:import')
  complete(
    @CurrentOrganization() o: { organizationId: string },
    @CurrentPrincipal() p: { userId: string },
    @Param('importId') id: string,
  ) {
    return this.contacts.completeImport(o.organizationId, p.userId, id);
  }
  @Get('contact-imports/:importId')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('contact:read')
  summary(@CurrentOrganization() o: { organizationId: string }, @Param('importId') id: string) {
    return this.contacts.importSummary(o.organizationId, id);
  }
}
