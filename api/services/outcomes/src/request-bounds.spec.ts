import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { OutcomesController } from './controllers';
import { SUBMISSION_ENTRIES_MAX } from './assessment.service';

/** A submission's arrays are bounded at the pipe the services install at boot (the service then holds them to the paper's size). */
describe('submit body bounds', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const SubmitDto = (Reflect.getMetadata('design:paramtypes', OutcomesController.prototype, 'submit') as (new () => object)[])[2];
  const check = (body: unknown) => pipe.transform(body, { type: 'body', metatype: SubmitDto });

  it.each(['responses', 'answers'])(`%s: ${SUBMISSION_ENTRIES_MAX} entries pass, one more is a 400`, async (field) => {
    const entries = (n: number) => Array.from({ length: n }, (_, i) => (field === 'answers' ? 0 : { index: i, selected_index: 0 }));
    await expect(check({ [field]: entries(SUBMISSION_ENTRIES_MAX) })).resolves.toBeDefined();
    await expect(check({ [field]: entries(SUBMISSION_ENTRIES_MAX + 1) })).rejects.toThrow(BadRequestException);
  });
});
