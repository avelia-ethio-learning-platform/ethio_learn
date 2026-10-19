import type { MigrationClass } from '@ethiopialearn/common';
import { Baseline1790955687490 } from './1790955687490-Baseline';
import { IndexTuning1790956081272 } from './1790956081272-IndexTuning';
import { EventDedupe1791050068634 } from './1791050068634-EventDedupe';
import { InboxReads1792355000565 } from './1792355000565-InboxReads';
import { CommentsCourseCreatedIndex1792400000000 } from './1792400000000-CommentsCourseCreatedIndex';

// Every migration of the notification schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [Baseline1790955687490, IndexTuning1790956081272, EventDedupe1791050068634, InboxReads1792355000565, CommentsCourseCreatedIndex1792400000000];
