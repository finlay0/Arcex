import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppPage } from "./app-page";
import { Developers } from "./developers";
import { Market } from "./market";
import { Radar } from "./radar";
import { Shell } from "./shell";
import { Tracking } from "./tracking";
import { Updates } from "./updates";
import "./index.css";

const router = createBrowserRouter([
  { path: "/desktop/link", lazy: async () => ({ Component: (await import("./accounts")).DesktopLinkPage }) },
  { path: "/account/devices", lazy: async () => ({ Component: (await import("./accounts")).DevicesPage }) },
  { path: "/owner/customers", lazy: async () => ({ Component: (await import("./accounts")).CustomersPage }) },
  {
    element: <Shell />,
    children: [
      { path: "/", element: <Radar /> },
      { path: "/saved", element: <Radar key="saved" scope="saved" /> },
      { path: "/history", element: <Radar key="history" scope="history" /> },
      { path: "/market", element: <Market /> },
      { path: "/updates", element: <Updates /> },
      { path: "/tracking", element: <Tracking /> },
      { path: "/developers", element: <Developers /> },
      { path: "/app/:slug/:step?", element: <AppPage /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>
  </StrictMode>,
);
