import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import MoriCafe from "./MoriCafe";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <MoriCafe />
  </StrictMode>,
);
