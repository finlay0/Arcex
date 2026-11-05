import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppPage } from "./app-page";
import { Developers } from "./developers";
import { AdsLibrary, ScreensLibrary } from "./library";
import { Radar } from "./radar";
import { Shell } from "./shell";
import { Tracking } from "./tracking";
import { Updates } from "./updates";
import "./index.css";

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "/", element: <Radar /> },
      { path: "/saved", element: <Radar key="saved" scope="saved" /> },
      { path: "/history", element: <Radar key="history" scope="history" /> },
      { path: "/updates", element: <Updates /> },
      { path: "/ads", element: <AdsLibrary /> },
      { path: "/screens", element: <ScreensLibrary /> },
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
