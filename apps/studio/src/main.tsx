import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { M1Prototype } from "./m1-prototype/M1Prototype";
import { M1Studio } from "./m1-studio/M1Studio";
import "./styles.css";

const search = new URLSearchParams(window.location.search);
const Root =
  search.get("prototype") === "m1"
    ? M1Prototype
    : search.get("studio") === "m1"
      ? M1Studio
      : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
