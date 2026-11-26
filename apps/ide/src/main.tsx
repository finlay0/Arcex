import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { Recover } from "./Recover.tsx";
import "./ui.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Recover>
      <App />
    </Recover>
  </StrictMode>,
);
