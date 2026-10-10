import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./styles/theme.css";
import "./modules"; // registers tool windows / popups / status widgets from each module
import "./actions/builtin"; // shell actions (must come after tool windows are importable; it also tracks late registrations)
import { installDispatcher } from "./actions/dispatcher";
import App from "./App";

installDispatcher();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
