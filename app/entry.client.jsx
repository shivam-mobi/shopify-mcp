import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
    {
      onRecoverableError(error, errorInfo) {
        // Silently recover from harmless hydration mismatches without console spam
        const msg = error?.message || String(error);
        if (msg.includes("418") || msg.includes("423") || msg.includes("Hydration")) {
          return;
        }
        if (process.env.NODE_ENV !== "production") {
          console.warn("[Hydration Recovery]", error, errorInfo);
        }
      },
    }
  );
});
