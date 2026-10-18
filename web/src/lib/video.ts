import type Hls from 'hls.js';

/**
 * Plays `url` in `video`. An HLS playlist goes through hls.js where the browser
 * supports it (MSE), and hls.js is only downloaded then, so it stays out of the
 * pages' first-load JS. Anything else, and HLS on a browser without MSE (iOS
 * Safari plays it natively), is set as the video's src. Returns the hls.js
 * instance to destroy when the player moves on, or null.
 */
export async function attachVideo(video: HTMLVideoElement, url: string, onFatalError?: () => void): Promise<Hls | null> {
  if (url.includes('.m3u8')) {
    const { default: HlsPlayer } = await import('hls.js');
    if (HlsPlayer.isSupported()) {
      const hls = new HlsPlayer();
      if (onFatalError) {
        hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
          if (data.fatal) onFatalError();
        });
      }
      hls.loadSource(url);
      hls.attachMedia(video);
      return hls;
    }
  }
  video.src = url;
  return null;
}
