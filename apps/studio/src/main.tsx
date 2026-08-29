import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { M1Prototype } from "./m1-prototype/M1Prototype";
import { M1Studio } from "./m1-studio/M1Studio";
import { resolveStudioRoute } from "./studio-route";
import "./styles.css";

const route = resolveStudioRoute(window.location.search);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {route === "m1-prototype" ? (
      <M1Prototype />
    ) : route === "m2" ? (
      <M1Studio milestone="m2" />
    ) : route === "m1" ? (
      <M1Studio milestone="m1" />
    ) : (
      <App />
    )}
  </StrictMode>,
);
