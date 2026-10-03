import { beforeEach, describe, expect, it, vi } from 'vitest';

const loaded = vi.fn();
const supported = { value: true };
const instances: { source?: string; media?: unknown; destroy: () => void }[] = [];

vi.mock('hls.js', () => {
  loaded();
  return {
    default: class {
      static Events = { ERROR: 'hlsError' };
      static isSupported = () => supported.value;
      source?: string;
      media?: unknown;
      constructor() {
        instances.push(this as never);
      }
      on() {}
      loadSource(url: string) {
        this.source = url;
      }
      attachMedia(media: unknown) {
        this.media = media;
      }
      destroy() {}
    },
  };
});

describe('attachVideo', () => {
  beforeEach(() => {
    vi.resetModules();
    loaded.mockClear();
    instances.length = 0;
    supported.value = true;
  });

  it('sets an MP4 as the src without downloading hls.js', async () => {
    const { attachVideo } = await import('./video');
    const video = document.createElement('video');
    expect(await attachVideo(video, 'http://localhost:9000/b/lesson.mp4?sig=1')).toBeNull();
    expect(video.src).toBe('http://localhost:9000/b/lesson.mp4?sig=1');
    expect(loaded).not.toHaveBeenCalled();
  });

  it('plays an HLS playlist through hls.js, loaded on first use', async () => {
    const { attachVideo } = await import('./video');
    const video = document.createElement('video');
    const hls = await attachVideo(video, 'http://localhost:9000/b/master.m3u8?sig=1');
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(hls).toBe(instances[0]);
    expect(instances[0]).toMatchObject({ source: 'http://localhost:9000/b/master.m3u8?sig=1', media: video });
  });

  it('falls back to the native player where hls.js is unsupported (iOS Safari)', async () => {
    supported.value = false;
    const { attachVideo } = await import('./video');
    const video = document.createElement('video');
    expect(await attachVideo(video, 'http://localhost:9000/b/master.m3u8')).toBeNull();
    expect(video.src).toBe('http://localhost:9000/b/master.m3u8');
  });
});
