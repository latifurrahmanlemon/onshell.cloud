import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "@xterm/xterm/css/xterm.css";
import "./app.css";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root element is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
