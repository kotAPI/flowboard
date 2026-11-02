import "@radui/ui/themes/default.css";
import Theme from "@radui/ui/Theme";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const client = new QueryClient({
  defaultOptions: { queries: { retry: (n, err: any) => n < 2 && !(err?.status >= 400 && err?.status < 500), staleTime: 5_000 } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* classNamespace is required for default.css to apply (https://github.com/rad-ui/ui/issues/2246) */}
    <Theme appearance="system" accentColor="iris" classNamespace="rad-ui" className="theme-root">
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </Theme>
  </StrictMode>,
);
