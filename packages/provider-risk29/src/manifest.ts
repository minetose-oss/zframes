import type { Capability, ProviderPluginManifest } from "@zframes/spec";
import { RISK29_CAPABILITIES } from "@zframes/spec/risk29";

export const RISK29_MANIFEST: ProviderPluginManifest = {
  id: "risk29",
  name: "Risk29 Intelligence",
  description:
    "Private Risk29 investment-risk snapshot and history. Scores, states, regime and freshness are calculated by the Risk29 engine; zframes only validates and renders them.",
  capabilities: RISK29_CAPABILITIES as unknown as readonly Capability[],
  sources: [
    {
      id: "risk29",
      name: "Risk29 Intelligence Engine",
      url: "https://github.com/minetose-oss/zframes",
      notes:
        "Private intelligence layer. Signal source/as-of/freshness are carried inside each Risk29 signal rather than inferred by the dashboard.",
    },
  ],
  // Phase 0A uses same-origin /risk29/*.json endpoints, so the provider needs no
  // public relay host grant. A later remote service must declare its host here.
  hosts: [],
};
