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
import { maybeInstallQa } from "./qa";
import { installWindowLifecycle } from "./lib/windowLifecycle";
import { initScheme } from "./theme";

installDispatcher();
installWindowLifecycle(); // close-requested prompt + native File menu actions
void maybeInstallQa(); // no-op unless ATELIER_AUTOMATION=1 (see src/qa)
void initScheme().finally(() => // colour scheme (global preference) is applied before the first paint
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  ));
