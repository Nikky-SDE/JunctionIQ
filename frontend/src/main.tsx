import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme } from "./components/ThemeToggle";
import App from "./App";
import "./index.css";

const savedTheme = window.localStorage.getItem("junction-iq-theme");
const initialTheme =
  savedTheme === "light" || savedTheme === "dark"
    ? savedTheme
    : window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
applyTheme(initialTheme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
