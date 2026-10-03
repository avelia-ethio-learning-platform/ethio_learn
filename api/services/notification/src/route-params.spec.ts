import { MODULE_METADATA } from '@nestjs/common/constants';
import { unpipedRouteParams } from '@ethiopialearn/common';
import { AppModule } from './app.module';

/**
 * Regression guard: every `@Param` on a controller this service registers must carry a
 * ParseUUIDPipe or a token/uid pipe, so a non-uuid is a 400 before any service code runs.
 */
describe('notification route params', () => {
  it('validates every route param', () => {
    const controllers: Function[] = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule);
    expect(controllers.length).toBeGreaterThan(0);
    expect(unpipedRouteParams(controllers)).toEqual([]);
  });
});
