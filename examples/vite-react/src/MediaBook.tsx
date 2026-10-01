import { useEffect, useRef, type CSSProperties } from 'react';
import { HTMLFlipBook, type FlipBookHandle } from '@gullabs/react-flipbook';
// The same host recipe the vanilla example uses — see docs/MEDIA-PAGES.md.
// The engine never plays or pauses media; this module does, from its events.
import { attachMediaPolicy } from '../../media-pages/media';
import { generateMedia } from '../../media-pages/source';

const leaf: CSSProperties = { boxSizing: 'border-box', height: '100%' };
const inner: CSSProperties = {
  boxSizing: 'border-box',
  height: '100%',
  padding: 12,
  background: '#fffaf0',
  fontFamily: 'system-ui, sans-serif',
};
// Real clips ship real captions (WCAG 1.2.2). This one-cue track stands in.
const captions = `data:text/vtt,${encodeURIComponent('WEBVTT\n\n00:00.000 --> 59:59.000\nA steady tone.\n')}`;

const fill: CSSProperties = { display: 'block', width: '100%', aspectRatio: '16 / 9' };

export function MediaBook() {
  const book = useRef<FlipBookHandle>(null);
  const loop = useRef<HTMLVideoElement>(null);
  const clip = useRef<HTMLVideoElement>(null);
  const detach = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Offline stand-ins for real files: `<video src="...">` needs none of this.
    const media = generateMedia('react');
    if (loop.current) loop.current.srcObject = media.picture;
    if (clip.current) clip.current.srcObject = media.withSound;
    return () => {
      detach.current?.();
      detach.current = null;
      media.stop();
    };
  }, []);

  return (
    <section>
      <h2 style={{ margin: '0 0 8px' }}>Media pages — the host owns playback</h2>
      <p style={{ margin: '0 0 12px', color: '#555', maxWidth: 520 }}>
        Attach the policy in <code>onReady</code> (once per engine) and detach it on unmount. Sound
        pauses as a turn starts; a muted loop runs on its own page and stops when that page leaves.
      </p>
      <HTMLFlipBook
        ref={book}
        width={300}
        height={220}
        usePortrait
        style={{ maxWidth: 620 }}
        aria-label="Media flipbook"
        onReady={() => {
          detach.current?.();
          const engine = book.current?.pageFlip();
          detach.current = engine ? attachMediaPolicy(engine) : null;
        }}
      >
        <div style={leaf}>
          <div style={inner}>Cover</div>
        </div>
        <div style={leaf}>
          <div style={inner}>
            <video ref={loop} muted loop playsInline style={fill} />
            Muted loop
          </div>
        </div>
        <div style={leaf}>
          <div style={inner}>
            <video ref={clip} controls playsInline style={fill}>
              <track kind="captions" srcLang="en" label="English" src={captions} default />
            </video>
            Clip with sound
          </div>
        </div>
        <div style={leaf}>
          <div style={inner}>End</div>
        </div>
      </HTMLFlipBook>
    </section>
  );
}
