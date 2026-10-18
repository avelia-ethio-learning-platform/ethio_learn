/** Pages here fade in on navigation (globals.css .route-enter; nothing under reduced motion). */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="route-enter">{children}</div>;
}
