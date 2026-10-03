import { MODULE_METADATA } from '@nestjs/common/constants';
import { unpipedRouteParams } from '@ethiopialearn/common';
import { AppModule } from './app.module';

/**
 * Regression guard: every `@Param` on a controller this service registers must carry a
 * ParseUUIDPipe or a token/uid pipe, so a non-uuid is a 400 before any service code runs.
 */
describe('course route params', () => {
  it('validates every route param', () => {
    const controllers: Function[] = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule);
    expect(controllers.length).toBeGreaterThan(0);
    // :title is the free-text knowledge entry title; it is only ever matched against stored rows.
    expect(unpipedRouteParams(controllers, ['CourseController.deleteKnowledge(:title)'])).toEqual([]);
  });
});
