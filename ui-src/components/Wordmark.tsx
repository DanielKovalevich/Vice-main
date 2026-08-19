/**
 * The VICE wordmark, set in Syne ExtraBold.
 *
 * The face is subset to the four glyphs it needs, 624 bytes, and inlined as a
 * data URI in vice/ui/index.html rather than shipped as a linked file. That is
 * deliberate: the boot cover paints before the bundle parses, and a linked
 * webfont would flash a fallback on the one screen whose whole job is hiding
 * load time. Inlining it in the document head means it is available to the
 * first paint and to React alike, from one copy and no extra request.
 *
 * Used in exactly three places: the sidebar, the About hero and the boot
 * cover. Everything else is Figtree.
 */
export function Wordmark({height = 20, className}: {height?: number; className?: string}) {
  return (
    <span className={className ? `wordmark ${className}` : 'wordmark'} style={{fontSize: height}}>
      VICE
    </span>
  );
}
