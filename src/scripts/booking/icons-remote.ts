// Page entry, rendered only when the page has server category icons: probes them once the page has loaded (see ./icon-probe).
import { probeRemote } from "./icon-probe";

if (document.readyState === "complete") probeRemote();
else window.addEventListener("load", () => setTimeout(() => probeRemote(), 0), { once: true });
