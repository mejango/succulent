"use client";

import { paraConnector } from "@getpara/wagmi-v2-connector";
import ParaWeb, { type Environment } from "@getpara/web-sdk";
import type { Transport } from "viem";
import type { CreateConnectorFn } from "wagmi";

export const PARA_APP = {
  appName: "Succulent",
  appDescription: "Every Juicebox payment, cash out, and rule change, as it lands.",
  appUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "https://succulent.money",
};

let client: ParaWeb | undefined;

/** Constructing Para starts its worker/session machinery. Keep the singleton
 * behind a user action so an anonymous page view performs no wallet traffic. */
export function getParaClient(): ParaWeb {
  client ??= new ParaWeb(
    (process.env.NEXT_PUBLIC_PARA_ENV as Environment) || "BETA",
    process.env.NEXT_PUBLIC_PARA_API_KEY ?? "",
  );
  return client;
}

export function createParaWagmiConnector(transports: Record<number, Transport>): CreateConnectorFn {
  // Para 3.8's declaration excludes Wagmi's nullable storage branch, although
  // its runtime connector implements the same interface.
  return paraConnector({
    para: getParaClient(),
    appName: PARA_APP.appName,
    options: {},
    disableModal: true,
    transports,
  }) as unknown as CreateConnectorFn;
}

/**
 * How Para's own pages should look when they appear inside ours.
 *
 * The verification code renders in an iframe in the sign-in sheet, so its default white-and-blue
 * portal styling would sit inside a shop panel looking like a foreign object. Para bakes this
 * into the URL it generates, so it has to travel with the auth call that asks for one.
 *
 * Values are the site's own tokens: the paper background, ink text, accent blue, and square
 * corners like everything else here.
 */
/** Nothing is fetched: whichever of these the visitor already has wins. */
const PARA_PORTAL_MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace';

export const PARA_PORTAL_THEME = {
  backgroundColor: "#E4EAE2",
  foregroundColor: "#1B2C27",
  accentColor: "#2C6A4D",
  mode: "light" as const,
  borderRadius: "none" as const,
  // NOT `font`. Para wraps that value in quotes — `"${font}", ui-sans-serif, …` — so a stack
  // passed there becomes one quoted family name that matches nothing, and the portal silently
  // renders sans. `cssOverrides` is applied afterwards, verbatim, and wins.
  cssOverrides: {
    fontFamily: PARA_PORTAL_MONO,
    "--para-font-sans": PARA_PORTAL_MONO,
  },
};
