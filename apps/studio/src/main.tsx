import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { M1Prototype } from "./m1-prototype/M1Prototype";
import { M1Studio } from "./m1-studio/M1Studio";
import { resolveStudioRoute } from "./studio-route";
import "./styles.css";

const route = resolveStudioRoute(window.location.search);
const Root =
  route === "m1-prototype" ? M1Prototype : route === "m1" ? M1Studio : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
