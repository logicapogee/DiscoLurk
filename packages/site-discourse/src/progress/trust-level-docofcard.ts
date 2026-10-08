import type { ProgressModule } from './types';

/** §5.1b */
export const trustLevelDocofcard: ProgressModule = {
  source: 'trust-level-docofcard',
  labelMap: {
    进入过的主题: 'topicsViewed',
    已读帖子: 'postsRead',
    '阅读时间（分钟）': 'readingTime',
    '注册时长（分钟）': 'other',
  },
};
