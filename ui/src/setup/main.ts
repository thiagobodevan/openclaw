import { SetupApp } from "./setup-app.ts";
import "./setup.css";

customElements.define("openclaw-setup-app", SetupApp);
document.body.innerHTML = "<openclaw-setup-app></openclaw-setup-app>";
