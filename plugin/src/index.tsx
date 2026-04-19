import { createRoot } from "react-dom/client";
import { Panel } from "./ui/Panel";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<Panel />);
}
