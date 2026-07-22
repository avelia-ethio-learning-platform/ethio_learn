import { Logger } from '@nestjs/common';

// Keep unit-test output readable: service Loggers write nothing.
Logger.overrideLogger(false);
