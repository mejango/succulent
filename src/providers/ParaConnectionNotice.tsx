"use client";

export function ParaConnectionNotice({
  onDismiss,
  onRetry,
}: {
  onDismiss: () => void;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="fixed bottom-4 right-4 z-[100] max-w-sm border border-rose/40 bg-farina p-4 text-sm shadow-lg"
    >
      <p className="font-medium text-pine">Embedded wallet connection needs attention</p>
      <p className="mt-1 text-stem">
        Succulent could not finish connecting your embedded wallet. Browser wallet options still work.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="min-h-11 border border-pine px-3 py-2 font-medium hover:bg-farina-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pine"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="min-h-11 px-3 py-2 text-stem hover:bg-farina-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pine"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
