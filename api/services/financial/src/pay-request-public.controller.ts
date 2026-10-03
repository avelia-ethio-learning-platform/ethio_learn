import { Controller, Get, Param } from '@nestjs/common';
import { PayRequestTokenPipe } from '@ethiopialearn/common';
import { SponsorshipService } from './sponsorship.service';

/**
 * Deliberately guard-less: the one anonymous route of the financial service. It lives apart
 * from GrowthController so that controller's class-level RolesGuard stays fail-closed for
 * every other route. Do not add routes or guards here.
 */
@Controller()
export class PayRequestPublicController {
  constructor(private readonly sponsorships: SponsorshipService) {}

  /** [PUBLIC] landing data for the "someone asked you to pay" page. */
  @Get('pay-requests/:token')
  payRequestPublic(@Param('token', new PayRequestTokenPipe()) token: string) {
    return this.sponsorships.payRequestPublic(token);
  }
}
