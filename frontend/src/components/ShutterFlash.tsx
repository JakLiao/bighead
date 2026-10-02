export function ShutterFlash({ show }: { show: boolean }) {
  if (!show) return null;
  return <div className="absolute inset-0 bg-white shutter-flash pointer-events-none" />;
}
