"use client";

import { PortalContainerProvider } from "@getpara/react-component-library";
import { ParaProvider } from "@getpara/react-sdk-lite";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { ParaRequest } from "./ParaAuthContext";
import ParaAuthSheet from "./ParaAuthSheet";
import { SignInShell } from "./SignInShell";
import { getParaClient, PARA_APP } from "./para-config";

/** Layout effects run before paint, which is the whole point here; on the
 *  server there is no paint and React warns, so fall back there. */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Dismiss on a click that both starts and ends on the backdrop.
 *
 * Checking only where the mouse came up would close the panel when a drag to
 * select text inside it happened to be released outside.
 */
function useBackdropDismiss(onDismiss: () => void) {
  const pressedBackdrop = useRef(false);
  return {
    onMouseDown(event: MouseEvent<HTMLElement>) {
      pressedBackdrop.current = event.target === event.currentTarget;
    },
    onClick(event: MouseEvent<HTMLElement>) {
      const dismiss = pressedBackdrop.current && event.target === event.currentTarget;
      pressedBackdrop.current = false;
      if (dismiss) onDismiss();
    },
  };
}

function Driver({
  requestId,
  request,
  onOpenChange,
  onSettled,
  onLive,
  entry,
  onEntryChange,
}: {
  requestId: number;
  request: ParaRequest;
  onOpenChange: (open: boolean) => void;
  onSettled: () => void;
  /** Fired once Para is initialised far enough for this to render at all. */
  onLive: () => void;
  entry: string;
  onEntryChange: (value: string) => void;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const handledRequest = useRef(0);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (requestId <= handledRequest.current) return;
    handledRequest.current = requestId;
    setSheetOpen(true);
  }, [requestId, request]);

  const closeSheet = useCallback(() => {
    setSheetOpen(false);
  }, []);

  const sheetBackdrop = useBackdropDismiss(() => closeSheet());

  // Para owns whether its own modal is showing; the host above owns the
  // dialog, because it has to open it before this component can exist at all
  // — ParaProvider renders nothing until Para's API answers.
  const open = sheetOpen;

  useEffect(() => onLive(), [onLive]);

  useEffect(() => {
    onOpenChange(open);
    if (wasOpen.current && !open) onSettled();
    wasOpen.current = open;
  }, [open, onOpenChange, onSettled]);

  if (!sheetOpen) return null;
  // The host contributes top-layer membership and nothing else — it paints no
  // backdrop and its `.ui-dialog` styling is `<dialog>`-scoped — so the sheet
  // brings its own dimmed surface and panel.
  return (
    <div
      className="flex h-full w-full items-center justify-center overflow-y-auto bg-pine/50 p-6"
      {...sheetBackdrop}
    >
      <div className="w-full max-w-sm border border-bloom bg-farina p-6">
        <ParaAuthSheet onClose={closeSheet} entry={entry} onEntryChange={onEntryChange} />
      </div>
    </div>
  );
}

/** Loaded only after a user requests embedded sign-in. */
export default function ParaModalHost({
  requestId,
  request,
  onOpenChange,
  onSettled,
  entry,
  onEntryChange,
}: {
  requestId: number;
  request: ParaRequest;
  onOpenChange: (open: boolean) => void;
  onSettled: () => void;
  entry: string;
  onEntryChange: (value: string) => void;
}) {
  const paraClient = getParaClient();

  // Sign-in is reachable from inside an app dialog, and a dialog opened with
  // `showModal()` inerts everything outside itself. So the Para overlay has to
  // be in the top layer too, which means it has to be a `showModal()` dialog:
  // the host below. Para renders its overlay through a portal container, so
  // `PortalContainerProvider` points that container at the host instead of the
  // body. The provider tree itself lives in the host as well, because Para's
  // warm-up iframe is a sibling of the overlay and has to stay above the
  // dialog underneath along with it.
  // Built during render rather than in an effect. Creating it afterwards
  // meant returning null for a render first — and since the placeholder has
  // already unmounted by then, that null is a frame of empty screen between
  // the two. Attaching it happens before paint for the same reason.
  const [host] = useState<HTMLDialogElement | null>(() => {
    if (typeof document === "undefined") return null;
    const dialog = document.createElement("dialog");
    dialog.className = "ui-modal-host";
    dialog.tabIndex = -1;
    dialog.dataset.uiModalPortal = "";
    return dialog;
  });
  // ParaProvider renders nothing until Para's API answers, so Driver — and
  // with it the sheet — does not exist for the first few hundred
  // milliseconds. Without this the dialog would sit closed and the visitor
  // would watch the page reappear between the placeholder and the sheet.
  const [driverOpen, setDriverOpen] = useState(false);
  const [driverLive, setDriverLive] = useState(false);
  // `requestId > 0` matters: the host is also mounted ahead of time to warm
  // Para up, and nothing should be on screen for that.
  const showShell = !driverLive && request.kind === "auth" && requestId > 0;
  const open = driverOpen || showShell;

  // Stable identities: Driver keys effects off these, so a closure recreated
  // each render would re-run them every render. The callers' own handlers are
  // not stable, so hold them in a ref rather than in the dependency list.
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const reportOpen = useCallback((next: boolean) => {
    setDriverOpen(next);
    onOpenChangeRef.current(next);
  }, []);
  const markDriverLive = useCallback(() => setDriverLive(true), []);

  useBeforePaint(() => {
    if (!host) return;
    // Escape belongs to Para's own dismissal path. Closing the host natively
    // would leave Para believing its modal was still open.
    const preventNativeCancel = (event: Event) => event.preventDefault();
    host.addEventListener("cancel", preventNativeCancel);
    document.body.appendChild(host);
    return () => {
      host.removeEventListener("cancel", preventNativeCancel);
      host.remove();
    };
  }, [host]);

  // Deliberately a passive effect, not a layout one: sign-in is reachable
  // from inside other dialogs, and this has to enter the top layer after
  // theirs to sit above them. Opening before paint would put it under.
  useEffect(() => {
    if (!host) return;
    if (open && !host.open) {
      host.showModal();
      // Keep the first open from landing focus (and a focus ring) on the sheet's close button.
      host.focus({ preventScroll: true });
    } else if (!open && host.open) host.close();
  }, [host, open]);

  if (!host) return null;

  return createPortal(
    <PortalContainerProvider container={host}>
      {/* Authentication is ours (ParaAuthSheet); Para's packaged modal stays
          mounted only to warm up its runtime — it renders no screen of its
          own in this flow. */}
      {showShell ? (
        <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-pine/50 p-6">
          <div className="w-full max-w-sm border border-bloom bg-farina p-6">
            <SignInShell entry={entry} onEntryChange={onEntryChange} />
          </div>
        </div>
      ) : null}
      <ParaProvider
        paraClientConfig={paraClient}
        config={{ appName: PARA_APP.appName }}
        paraModalConfig={{
          authLayout: ["AUTH:FULL"],
          oAuthMethods: ["GOOGLE", "TWITTER", "APPLE", "DISCORD", "FARCASTER"],
          // Succulent's own tokens; square corners like the rest of the page.
          theme: {
            mode: "light",
            backgroundColor: "#E4EAE2",
            foregroundColor: "#1B2C27",
            accentColor: "#2C6A4D",
            font: "IBM Plex Mono",
            borderRadius: "none",
          },
        }}
        externalWalletConfig={{ wallets: [] }}
      >
        <Driver
          requestId={requestId}
          request={request}
          onOpenChange={reportOpen}
          onSettled={onSettled}
          onLive={markDriverLive}
          entry={entry}
          onEntryChange={onEntryChange}
        />
      </ParaProvider>
    </PortalContainerProvider>,
    host,
  );
}
