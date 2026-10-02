import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { RolesGuard } from '@ethiopialearn/common';
import { AppModule } from './app.module';
import { GrowthController } from './growth.controller';
import { PayRequestPublicController } from './pay-request-public.controller';

/** Route handlers of a controller class: [http method, path, handler name]. */
function routes(controller: Function): Array<[RequestMethod, string, string]> {
  return Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => [name, controller.prototype[name]] as const)
    .filter(([, handler]) => Reflect.hasMetadata(PATH_METADATA, handler))
    .map(([name, handler]) => [
      Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
      Reflect.getMetadata(PATH_METADATA, handler) as string,
      name,
    ]);
}

describe('anonymous pay-link read', () => {
  it('PayRequestPublicController has no guards on the class or on its handler', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PayRequestPublicController)).toBeUndefined();
    const handlers = routes(PayRequestPublicController);
    expect(handlers).toEqual([[RequestMethod.GET, 'pay-requests/:token', 'payRequestPublic']]);
    for (const [, , name] of handlers) {
      expect(Reflect.getMetadata(GUARDS_METADATA, PayRequestPublicController.prototype[name as 'payRequestPublic'])).toBeUndefined();
    }
  });

  it('is registered in the financial module', () => {
    const controllers: Function[] = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule);
    expect(controllers).toContain(PayRequestPublicController);
  });

  it('GrowthController keeps RolesGuard at class level', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, GrowthController)).toContain(RolesGuard);
  });

  it('GrowthController no longer has a GET pay-requests/:token handler', () => {
    const gets = routes(GrowthController).filter(([method, path]) => method === RequestMethod.GET && path === 'pay-requests/:token');
    expect(gets).toEqual([]);
  });

  it('POST pay-requests/:token/pay stays on GrowthController', () => {
    const posts = routes(GrowthController).filter(([method, path]) => method === RequestMethod.POST && path === 'pay-requests/:token/pay');
    expect(posts).toHaveLength(1);
  });
});
