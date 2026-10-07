// framer-motion's animation features, in their own chunk: Providers loads them
// lazily, so they stay out of every page's first-load JS. domMax rather than
// domAnimation, because the header's nav underline animates with `layoutId`.
export { domMax as default } from 'framer-motion';
