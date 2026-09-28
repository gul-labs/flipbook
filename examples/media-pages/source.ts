/**
 * Self-contained media for the example: a canvas animation captured as a
 * video stream, plus a WebAudio tone. Nothing is downloaded and no binary is
 * committed. The frame counter is burned into the picture, so a fold that
 * shows a different frame from its page is visible at a glance.
 *
 * A real book uses files. `?video=<url>` swaps the generated video for one.
 */

export interface GeneratedMedia {
  /** Silent picture, for decorative loops. */
  picture: MediaStream;
  /** Picture plus a tone, for a narrated clip. Audio starts after `unlock()`. */
  withSound: MediaStream;
  /** The tone alone, for an `<audio>` element. */
  sound: MediaStream;
  /** Resume the AudioContext from a user gesture (autoplay policy). */
  unlock(): Promise<void>;
  /** Stop the animation, the tracks and the AudioContext. */
  stop(): void;
}

export function generateMedia(label: string): GeneratedMedia {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2d canvas unavailable');

  let frame = 0;
  let raf = 0;
  const draw = (): void => {
    frame += 1;
    const hue = (frame * 2) % 360;
    ctx.fillStyle = `hsl(${hue} 60% 45%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.fillRect((frame * 3) % canvas.width, 150, 24, 12);
    ctx.font = 'bold 28px system-ui, sans-serif';
    ctx.fillText(label, 16, 48);
    ctx.font = '22px ui-monospace, monospace';
    ctx.fillText(`frame ${frame}`, 16, 96);
    raf = requestAnimationFrame(draw);
  };
  draw();

  const picture = canvas.captureStream(30);
  const audio = new AudioContext();
  const tone = audio.createOscillator();
  const gain = audio.createGain();
  gain.gain.value = 0.05;
  tone.frequency.value = 330;
  const out = audio.createMediaStreamDestination();
  tone.connect(gain).connect(out);
  tone.start();

  return {
    picture,
    withSound: new MediaStream([...picture.getVideoTracks(), ...out.stream.getAudioTracks()]),
    sound: out.stream,
    unlock: () => audio.resume(),
    stop: () => {
      cancelAnimationFrame(raf);
      tone.stop();
      for (const track of [...picture.getTracks(), ...out.stream.getTracks()]) track.stop();
      void audio.close();
    },
  };
}
